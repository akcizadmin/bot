// One-time helper: links to WhatsApp (QR scan on first run) and prints every
// group chat's name and JID so you can fill in GROUP_JIDS in .env.
// Run with: npm run list-groups
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(join(projectRoot, 'auth'));
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      console.log('\nScan with WhatsApp (Settings → Linked Devices → Link a Device):\n');
      qrcode.generate(update.qr, { small: true });
    }
    if (update.connection === 'open') {
      console.log('Connected. Fetching groups...\n');
      const groups = await sock.groupFetchAllParticipating();
      const entries = Object.values(groups).sort((a, b) =>
        (a.subject ?? '').localeCompare(b.subject ?? ''),
      );
      if (entries.length === 0) {
        console.log('No groups found. (Newly linked devices can take a minute to sync — try again.)');
      }
      for (const group of entries) {
        console.log(`${group.subject}\n  ${group.id}\n`);
      }
      console.log('Copy the JIDs of your sales groups into .env as GROUP_JIDS (comma-separated).');
      process.exit(0);
    }
    if (update.connection === 'close') {
      console.error('Connection closed. Run again (first link sometimes needs a restart after pairing).');
      process.exit(1);
    }
  });
}

void main();
