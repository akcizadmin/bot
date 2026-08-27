import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { handleMessage, sendTracked } from './handlers.ts';
import { startScheduler } from './scheduler.ts';
import { startWatcher } from './watcher.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });

let reconnectDelay = 2_000;
let currentSock: ReturnType<typeof makeWASocket> | null = null;
let watcherStarted = false;

async function start(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(join(projectRoot, 'auth'));

  const sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false,
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Settings → Linked Devices → Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectDelay = 2_000;
      console.log(`Connected. Posting to $Closed-Won$ (${config.closedWonGroupJid}).`);
      if (!watcherStarted) {
        watcherStarted = true;
        // Watcher and scheduler outlive individual sockets; always send via the
        // current one. sendTracked verifies personal JIDs with WhatsApp itself.
        const send = async (chatJid: string, text: string) => {
          if (!currentSock) throw new Error('WhatsApp not connected');
          await sendTracked(currentSock, chatJid, text);
        };
        startWatcher(send);
        startScheduler(send);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('Logged out from WhatsApp. Delete the auth/ folder and re-link.');
        process.exit(1);
      }
      console.warn(`Connection closed (status ${statusCode}). Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => void start(), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      if (
        msg.key.remoteJid === config.closedWonGroupJid ||
        msg.key.remoteJid === config.activationGroupJid
      ) {
        const text =
          msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '(no text)';
        console.log(
          `[group msg] type=${type} fromMe=${msg.key.fromMe ?? false} from=${msg.pushName ?? '?'}: "${String(text).slice(0, 50)}"`,
        );
      }
    }
    if (type !== 'notify') return;
    for (const msg of messages) {
      handleMessage(sock, msg).catch((err) => console.error('Message handling failed:', err));
    }
  });
}

void start();
