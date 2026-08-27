// Time-based agent triggers. Minute tick; runs are deduped per-day via
// data/agent-state.json so restarts never double-send.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsEnabled } from './agents/client.ts';
import { runPipelineCoach } from './agents/pipelineCoach.ts';
import { loadReps } from './agents/reps.ts';
import { config } from './config.ts';
import { fetchTeamNames } from './crm.ts';
import {
  fetchActivationInfo,
  fetchFulfillmentDeals,
  readState as readFulfillmentState,
  renderLifecycleTracker,
  renderSummary,
} from './agents/fulfillment.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = process.env.AGENT_STATE_PATH ?? join(projectRoot, 'data', 'agent-state.json');

type SendText = (chatJid: string, text: string) => Promise<void>;

interface AgentState {
  lastCoachRun?: string; // YYYY-MM-DD
  lastFulfillmentSummary?: string; // YYYY-MM-DD
}

function readState(): AgentState {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as AgentState;
  } catch {
    return {};
  }
}

function writeState(patch: Partial<AgentState>): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ ...readState(), ...patch }));
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * True when a weekday-morning job (at `hour`) should fire. Only fires inside a
 * 4-hour morning window, so a bot that was down and comes back in the evening
 * doesn't send "morning" briefs at 7pm — it just waits for the next morning.
 * Exported for tests.
 */
export function dailyJobIsDue(now: Date, lastRun: string | undefined, hour: number): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // weekends off
  if (now.getHours() < hour || now.getHours() >= hour + 4) return false;
  return lastRun !== localDateKey(now);
}

export const coachIsDue = (now: Date, lastRun: string | undefined): boolean => dailyJobIsDue(now, lastRun, 8);

export function startScheduler(sendText: SendText): void {
  const coachEnabled = agentsEnabled() && Boolean(loadReps());
  if (!agentsEnabled()) console.log('Sales agents disabled: ANTHROPIC_API_KEY not set.');
  else if (!loadReps()) console.log('Sales agents disabled: reps.json missing or phone numbers not filled in yet.');
  const fulfillmentEnabled = Boolean(config.fulfillmentGroupJid);
  if (!coachEnabled && !fulfillmentEnabled) return;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      if (coachEnabled && coachIsDue(now, readState().lastCoachRun)) {
        writeState({ lastCoachRun: localDateKey(now) }); // claim before the (slow) run
        console.log('Running morning pipeline coach...');
        const result = await runPipelineCoach(sendText);
        console.log(`Coach done: ${result.briefsSent} briefs, ${result.errors.length} errors.`);
      }
      if (fulfillmentEnabled && dailyJobIsDue(now, readState().lastFulfillmentSummary, 8)) {
        writeState({ lastFulfillmentSummary: localDateKey(now) });
        const state = readFulfillmentState();
        if (state.baselined) {
          const deals = await fetchFulfillmentDeals(await fetchTeamNames());
          await sendText(config.fulfillmentGroupJid!, renderSummary(deals, state));
          await sendText(config.fulfillmentGroupJid!, renderLifecycleTracker(deals, await fetchActivationInfo(), state));
          console.log('Fulfillment morning summary + tracker sent.');
        }
      }
    } catch (err) {
      console.error('Scheduler tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
  const parts: string[] = [];
  if (coachEnabled) {
    const mode = process.env.AGENT_TEST_MODE !== '0' ? 'TEST MODE (all DMs → admin)' : 'LIVE';
    parts.push(`coach weekdays 8am (${mode})`);
  }
  if (fulfillmentEnabled) parts.push('fulfillment summary weekdays 8am');
  console.log(`Scheduler started — ${parts.join('; ')}.`);
}
