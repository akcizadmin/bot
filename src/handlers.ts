import { jidNormalizedUser, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { agentsEnabled } from './agents/client.ts';
import { runPipelineCoach } from './agents/pipelineCoach.ts';
import { loadReps } from './agents/reps.ts';
import { config } from './config.ts';
import { fetchActivationStats, fetchBreakdown, fetchTeamNames } from './crm.ts';
import {
  fetchActivationInfo,
  fetchFulfillmentDeals,
  matchPurchaseReply,
  readState as readFulfillmentState,
  renderLifecycleTracker,
  renderSummary,
  writeState as writeFulfillmentState,
} from './agents/fulfillment.ts';
import { renderActivationBoard, renderLeaderboard } from './leaderboard.ts';

/** Commands Dan can send in his self-chat. Currently: !coach (force a brief run). */
const ADMIN_TARGETS: Record<string, () => string | null> = {
  fulfillment: () => config.fulfillmentGroupJid,
  closedwon: () => config.closedWonGroupJid,
  activation: () => config.activationGroupJid,
};

async function handleAdminCommand(sock: WASocket, chatJid: string, text: string): Promise<void> {
  const trimmed = text.trim();

  // "!post <target>\n<message>" — post arbitrary text into a configured group as the bot.
  const post = /^!post\s+(\w+)\s*\n([\s\S]+)$/i.exec(trimmed);
  if (post) {
    const target = ADMIN_TARGETS[post[1].toLowerCase()]?.();
    if (!target) {
      await sendTracked(sock, chatJid, `⚠️ Destino desconocido. Usa: ${Object.keys(ADMIN_TARGETS).join(', ')}`);
      return;
    }
    await sendTracked(sock, target, post[2].trim());
    await sendTracked(sock, chatJid, `✅ Publicado en ${post[1]}.`);
    return;
  }

  if (!/^!coach\b/i.test(trimmed)) return;
  if (!agentsEnabled()) {
    await sendTracked(sock, chatJid, '⚠️ Agents off: falta ANTHROPIC_API_KEY en .env');
    return;
  }
  await sendTracked(sock, chatJid, '⏳ Generando briefs del pipeline...');
  try {
    const result = await runPipelineCoach((jid, t) => sendTracked(sock, jid, t));
    await sendTracked(
      sock,
      chatJid,
      `✅ Coach: ${result.briefsSent} briefs${result.errors.length ? ` · ⚠️ ${result.errors.length} errores` : ''}`,
    );
  } catch (err) {
    await sendTracked(sock, chatJid, `⚠️ Coach falló: ${err instanceof Error ? err.message : err}`);
  }
}

// IDs of messages this bot sent, so its own posts are never treated as commands.
const sentByBot = new Set<string>();
const BOT_POST_PREFIX = /^(📊|⚡|⚠️)/;

// Personal JIDs are verified with WhatsApp before sending (accounts may live at
// a different canonical address, e.g. Mexican 52/521 variants or LID chats).
const jidCache = new Map<string, string>();

/** Mexican mobiles may be registered as 52+10 digits or 521+10 digits — try both. */
export function mxVariants(digits: string): string[] {
  if (digits.startsWith('521') && digits.length === 13) return [digits, `52${digits.slice(3)}`];
  if (digits.startsWith('52') && digits.length === 12) return [digits, `521${digits.slice(2)}`];
  return [digits];
}

async function canonicalJid(sock: WASocket, jid: string): Promise<string> {
  if (!jid.endsWith('@s.whatsapp.net')) return jid; // groups/lids pass through
  const hit = jidCache.get(jid);
  if (hit) return hit;
  const digits = jid.split('@')[0];
  let lookedUp = false;
  try {
    const results = (await sock.onWhatsApp(...mxVariants(digits))) ?? [];
    lookedUp = true;
    const found = results.find((r) => r?.exists && r.jid);
    if (found?.jid) {
      console.log(`JID resolved: ${digits} → ${found.jid}`);
      jidCache.set(jid, found.jid);
      return found.jid;
    }
  } catch (err) {
    console.warn('JID lookup failed (network?):', err instanceof Error ? err.message : err);
  }
  if (lookedUp) {
    // Definitive: WhatsApp says no such account. Never send into the void.
    throw new Error(`no WhatsApp account found for +${digits}`);
  }
  return jid; // lookup itself failed — best effort
}

export async function sendTracked(sock: WASocket, chatJid: string, text: string): Promise<void> {
  const target = await canonicalJid(sock, chatJid);
  // Group posts to the fulfillment room tag the purchasing team so they get a
  // push even with the group muted. Text needs "@<digits>" tokens; the mentions
  // array carries the verified addresses.
  if (target === config.fulfillmentGroupJid && config.fulfillmentMentions.length > 0) {
    const mentions: string[] = [];
    const tags: string[] = [];
    for (const phone of config.fulfillmentMentions) {
      const jid = await canonicalJid(sock, `${phone}@s.whatsapp.net`).catch(() => null);
      if (!jid) continue;
      mentions.push(jid);
      tags.push(`@${jid.split('@')[0]}`);
    }
    if (mentions.length > 0) {
      const sent = await sock.sendMessage(target, { text: `${text}\n\n${tags.join(' ')}`, mentions });
      if (sent?.key?.id) sentByBot.add(sent.key.id);
      return;
    }
  }
  const sent = await sock.sendMessage(target, { text });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
}

function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return m.conversation ?? m.extendedTextMessage?.text ?? null;
}

async function handleFulfillmentMessage(sock: WASocket, chatJid: string, text: string): Promise<void> {
  const trimmed = text.trim();
  const wantsSummary = /^!(pendientes|pending|fulfillment)\b/i.test(trimmed);
  const wantsTracker = /^!(tracker|tracking|seguimiento)\b/i.test(trimmed);
  const looksLikeConfirm = /^(comprado|comprada|purchased|bought)\b/i.test(trimmed);
  if (!wantsSummary && !wantsTracker && !looksLikeConfirm) return;

  try {
    const deals = await fetchFulfillmentDeals(await fetchTeamNames());
    const state = readFulfillmentState();

    if (wantsSummary) {
      await sendTracked(sock, chatJid, renderSummary(deals, state));
      return;
    }
    if (wantsTracker) {
      await sendTracked(sock, chatJid, renderLifecycleTracker(deals, await fetchActivationInfo(), state));
      return;
    }

    const matches = matchPurchaseReply(trimmed, deals, state);
    if (!matches || matches.length === 0) {
      await sendTracked(sock, chatJid, '🤔 No encontré ese deal entre los pendientes de compra. Escribe *!pendientes* para ver la lista.');
      return;
    }
    if (matches.length > 1) {
      const names = matches.map((d) => `• ${d.name}`).join('\n');
      await sendTracked(sock, chatJid, `🤔 Coincide con varios deals — sé más específica:\n${names}`);
      return;
    }
    const [deal] = matches;
    state.purchased[deal.id] = new Date().toISOString();
    writeFulfillmentState(state);
    const remaining = deals.filter((d) => d.stage === 'closed_won' && !state.purchased[d.id]);
    await sendTracked(
      sock,
      chatJid,
      `✅ Marcado como comprado: *${deal.name}* (${deal.number_of_kits ?? 0} kits). Quedan ${remaining.length} deal${remaining.length === 1 ? '' : 's'} por comprar.`,
    );
  } catch (err) {
    console.error('Fulfillment message handling failed:', err instanceof Error ? err.message : err);
    await sendTracked(sock, chatJid, '⚠️ No pude consultar el CRM ahora — intenta en un minuto.');
  }
}

export async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const chatJid = msg.key.remoteJid;
  if (!chatJid || !msg.key.id || sentByBot.has(msg.key.id)) return;

  // Admin command channel: Dan's "Message yourself" chat. That chat can appear
  // under the phone-number JID or the account's LID — accept both.
  const registry = loadReps();
  const selfJids = new Set(
    [
      registry?.admin.jid,
      sock.user?.id ? jidNormalizedUser(sock.user.id) : null,
      sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
    ].filter((j): j is string => Boolean(j)),
  );
  if (registry && selfJids.has(chatJid)) {
    await handleAdminCommand(sock, chatJid, extractText(msg) ?? '');
    return;
  }

  // Fulfillment group: Ilse's purchase confirmations + !pendientes summary.
  if (config.fulfillmentGroupJid && chatJid === config.fulfillmentGroupJid) {
    const text = extractText(msg);
    if (text && !BOT_POST_PREFIX.test(text.trim())) await handleFulfillmentMessage(sock, chatJid, text);
    return;
  }

  const isClosedWon = chatJid === config.closedWonGroupJid;
  const isActivation = chatJid === config.activationGroupJid;
  if (!isClosedWon && !isActivation) return; // only the two configured groups

  const text = extractText(msg);
  if (!text || BOT_POST_PREFIX.test(text.trim())) return;

  if (/^!leaderboard\b/i.test(text.trim())) {
    try {
      if (isClosedWon) {
        await sendTracked(sock, chatJid, renderLeaderboard(await fetchBreakdown()));
      } else {
        await sendTracked(sock, chatJid, renderActivationBoard(await fetchActivationStats()));
      }
    } catch (err) {
      console.error('!leaderboard failed:', err instanceof Error ? err.message : err);
      await sendTracked(sock, chatJid, '⚠️ Could not reach the CRM right now — try again in a minute.');
    }
  }
}
