// One-shot: connect with the bot's session, post a message to a group, exit.
// Usage: node --env-file=.env scripts/post-once.ts <groupJid> <path-to-text-file>
// NOTE: stop the launchd service first (two connections corrupt the session).
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import { readFileSync } from 'node:fs';

const [jid, file] = process.argv.slice(2);
if (!jid || !file) {
  console.error('usage: post-once.ts <jid> <textfile>');
  process.exit(1);
}
const text = readFileSync(file, 'utf8').trim();
const { state, saveCreds } = await useMultiFileAuthState('auth');
const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false });
sock.ev.on('creds.update', saveCreds);
sock.ev.on('connection.update', async (u) => {
  if (u.connection === 'open') {
    await sock.sendMessage(jid, { text });
    console.log('posted');
    setTimeout(() => process.exit(0), 1500);
  }
  if (u.connection === 'close') {
    console.log('closed before posting');
    process.exit(1);
  }
});
setTimeout(() => {
  console.log('timeout');
  process.exit(1);
}, 30000);
