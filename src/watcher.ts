// Polls the CRM for changes. Two boards:
//  - kits sold (closed-won opportunities) → $Closed-Won$ group on any change
//  - kits live (activation queue) → AcTiVaTiOn group when kits go live
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { fetchActivationStats, fetchBreakdown, fetchTeamNames } from './crm.ts';
import { renderActivationBoard, renderLeaderboard } from './leaderboard.ts';
import {
  fetchActivationInfo,
  fetchFulfillmentDeals,
  lifecycleStage,
  pendingNotices,
  readState as readFulfillmentState,
  renderNotice,
  renderShippedNotice,
  writeState as writeFulfillmentState,
} from './agents/fulfillment.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = process.env.STATE_PATH ?? join(projectRoot, 'data', 'state.json');

type SendText = (chatJid: string, text: string) => Promise<void>;

interface State {
  marker?: string; // kits-sold change marker
  liveTotal?: number; // legacy (pre line-id tracking)
  liveMarker?: string; // activation change marker
  liveLineIds?: string[]; // ids of currently-live service lines
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as State;
  } catch {
    return {};
  }
}

function writeState(patch: Partial<State>): void {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(next));
}

/** Kits-sold board posts on any change (except the very first baseline poll). */
export function shouldPost(lastMarker: string | null | undefined, marker: string): boolean {
  if (lastMarker == null) return false;
  return lastMarker !== marker;
}

/** Ids that are live now but weren't before. First baseline (no prior ids): empty. */
export function newlyLiveIds(prevIds: string[] | null | undefined, currentIds: string[]): string[] {
  if (prevIds == null) return [];
  const prev = new Set(prevIds);
  return currentIds.filter((id) => !prev.has(id));
}

async function pollKitsSold(sendText: SendText): Promise<void> {
  const breakdown = await fetchBreakdown();
  const { marker } = readState();
  if (shouldPost(marker, breakdown.marker)) {
    console.log(`Kits-sold change (${marker} → ${breakdown.marker}) — posting leaderboard`);
    await sendText(config.closedWonGroupJid, renderLeaderboard(breakdown));
  }
  if (marker !== breakdown.marker) writeState({ marker: breakdown.marker });
}

async function pollActivations(sendText: SendText): Promise<void> {
  const stats = await fetchActivationStats();
  const { liveLineIds, liveMarker } = readState();
  const currentIds = stats.liveLines.map((l) => l.id);
  const newIds = new Set(newlyLiveIds(liveLineIds, currentIds));
  if (newIds.size > 0) {
    const newLines = stats.liveLines.filter((l) => newIds.has(l.id));
    console.log(`${newIds.size} kit(s) went live — posting activation board`);
    await sendText(config.activationGroupJid, renderActivationBoard(stats, newLines));
  }
  if (liveMarker !== stats.marker || (liveLineIds?.length ?? -1) !== currentIds.length) {
    writeState({ liveLineIds: currentIds, liveMarker: stats.marker, liveTotal: stats.totalLive });
  }
}

async function pollFulfillment(sendText: SendText): Promise<void> {
  if (!config.fulfillmentGroupJid) return; // not configured yet
  const deals = await fetchFulfillmentDeals(await fetchTeamNames());
  const state = readFulfillmentState();

  if (!state.baselined) {
    // First run: remember current stages silently so deploy doesn't replay history.
    for (const d of deals) state.notified[d.id] = d.stage;
    state.baselined = true;
    writeFulfillmentState(state);
    console.log(`Fulfillment baselined: ${deals.length} deals in negotiation/closed_won.`);
    return;
  }

  const pending = pendingNotices(deals, state);
  for (const d of pending) {
    await sendText(config.fulfillmentGroupJid, renderNotice(d));
    state.notified[d.id] = d.stage;
    writeFulfillmentState(state);
    console.log(`Fulfillment notice sent: ${d.name} (${d.stage})`);
  }

  // Lifecycle events: shipped + fully live, per won deal.
  const acts = await fetchActivationInfo();
  const won = deals.filter((d) => d.stage === 'closed_won');
  if (!state.lifecycleBaselined) {
    for (const d of won) {
      const act = acts.get(d.id);
      if (!act) continue;
      if (act.shipped_at || act.shipping_confirmed || act.shipping_reference) state.shippedNotified[act.id] = true;
      if (lifecycleStage(d, act, state) === 'activado') state.liveNotified[act.id] = true;
    }
    state.lifecycleBaselined = true;
    writeFulfillmentState(state);
    console.log('Fulfillment lifecycle baselined.');
    return;
  }
  for (const d of won) {
    const act = acts.get(d.id);
    if (!act) continue;
    const shipped = Boolean(act.shipped_at || act.shipping_confirmed || act.shipping_reference);
    if (shipped && !state.shippedNotified[act.id]) {
      await sendText(config.fulfillmentGroupJid, renderShippedNotice(d, act));
      state.shippedNotified[act.id] = true;
      writeFulfillmentState(state);
      console.log(`Fulfillment shipped notice: ${d.name}`);
    }
    // Go-live is celebrated in the AcTiVaTiOn group already — no closure post here.
  }
}

export function startWatcher(sendText: SendText): void {
  let polling = false;

  const poll = async () => {
    if (polling) return; // single-flight
    polling = true;
    const results = await Promise.allSettled([
      pollKitsSold(sendText),
      pollActivations(sendText),
      pollFulfillment(sendText),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('CRM poll failed:', r.reason instanceof Error ? r.reason.message : r.reason);
      }
    }
    polling = false;
  };

  void poll();
  setInterval(() => void poll(), config.crmPollSeconds * 1000);
  const fulfillment = config.fulfillmentGroupJid ? ' + fulfillment' : '';
  console.log(`Watching CRM: kits sold + activation queue${fulfillment} (every ${config.crmPollSeconds}s).`);
}
