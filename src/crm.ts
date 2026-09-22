// Pulls the "Sales rep breakdown — kits sold" numbers from the Akciz Connect
// CRM (Lovable app, Supabase project qqmivcilgpgzinldpipn), replicating
// src/lib/kitEvents.ts + src/components/exec/SalesRepExecPanel.tsx so
// WhatsApp always matches the dashboard at app.akciz.com.
//
// 2026-09-20: the CRM moved "kits sold" math from raw opportunities rows to a
// kit-events timeline (src/lib/kitEvents.ts, commit a060885 on 2026-09-11,
// wired into the dashboard the same day). Kits added onto an *existing*
// closed-won deal ("expansion" activation_bundles, label starting with
// "Expansion") now count on the date the expansion was booked, not the
// deal's original close date — otherwise a customer who buys 2 kits in March
// and 3 more in September would have all 5 show up in March forever. This
// file mirrors that: buildKitEvents()/fetchKitEvents() replace the old direct
// opportunities query, and computeBreakdown() now consumes KitEvent rows.
//
// WEEKLY_KIT_OVERRIDES also mirrors the CRM's KitsExecHeader.tsx, which is
// empty now that the Robert Gonzalez kit-count cleanup landed. Keep both
// empty together, or both updated together if a cap is ever needed again.
import { createClient } from '@supabase/supabase-js';
import { config } from './config.ts';

export interface RepStat {
  id: string;
  name: string;
  total: number;
  month: number;
  week: number;
}

export interface Breakdown {
  reps: RepStat[];
  team: { total: number; month: number; week: number };
  /** Cheap change signature — if this differs from the last one, something closed. */
  marker: string;
}

/** One kit-sold event: the base kits at close, or one per expansion bundle. Mirrors src/lib/kitEvents.ts. */
export interface KitEvent {
  ownerId: string | null;
  kits: number;
  date: Date;
}

interface OpportunityRow {
  id: string;
  owner_id: string | null;
  number_of_kits: number | null;
  closed_at: string | null;
  created_at: string | null;
}

/** activation_bundles rows shaped for expansion detection. Mirrors src/lib/kitEvents.ts's BundleRow. */
interface ExpansionBundleRow {
  opportunity_id: string;
  label: string | null;
  kit_count: number | null;
  status: string | null;
  created_at: string | null;
  sold_by: string | null;
  sold_on: string | null;
}

interface TeamMember {
  user_id: string | null;
  display_name: string | null;
  email: string | null;
}

/**
 * Mirrors WEEKLY_KIT_OVERRIDES in the CRM's KitsExecHeader.tsx: display-only
 * caps on "this week". Empty by default, same as the dashboard — weekly kit
 * totals come straight from the kit-events data.
 */
export const WEEKLY_KIT_OVERRIDES: Record<string, number> = {};

export const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: true },
});

/** Signs in as the bot's CRM user (same auth as the dashboard) if not already. */
export async function ensureAuthed(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const { error } = await supabase.auth.signInWithPassword({
    email: config.crmBotEmail,
    password: config.crmBotPassword,
  });
  if (error) throw new Error(`CRM login failed for ${config.crmBotEmail}: ${error.message}`);
}

/** CRM user id → display name, via the same list_team RPC the dashboard uses. */
export async function fetchTeamNames(): Promise<Map<string, string>> {
  await ensureAuthed();
  const team = await supabase.rpc('list_team');
  if (team.error) throw new Error(`list_team query failed: ${team.error.message}`);
  const names = new Map<string, string>();
  for (const m of (team.data ?? []) as TeamMember[]) {
    if (m?.user_id) names.set(m.user_id, m.display_name || m.email || 'Unknown rep');
  }
  return names;
}

/** Monday 00:00 local time — same week definition as the dashboard. */
export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/**
 * Parse a stored date. A bare "YYYY-MM-DD" (what the Add Kits date box
 * writes) is read as UTC midnight by `new Date`, which lands in the previous
 * week/month for anyone west of UTC — so date-only values are built in local
 * time instead. Mirrors src/lib/kitEvents.ts's parseEventDate.
 */
export function parseEventDate(raw: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(raw);
}

/** True for an activation_bundles.label that marks an expansion sale. Mirrors src/lib/expansionKits.ts. */
export function isExpansionBundle(label?: string | null): boolean {
  return String(label ?? '')
    .trim()
    .toLowerCase()
    .startsWith('expansion');
}

/**
 * Splits closed-won deals into kit-sold events: the original kits at the
 * close date, plus one event per expansion bundle dated when that expansion
 * was booked. Mirrors src/lib/kitEvents.ts's buildKitEvents exactly so the
 * bot's totals bucket into the same week/month as the dashboard.
 */
export function buildKitEvents(opps: OpportunityRow[], bundles: ExpansionBundleRow[]): KitEvent[] {
  const byOpp = new Map<string, OpportunityRow>();
  for (const o of opps) byOpp.set(o.id, o);

  const expansions = new Map<string, { kits: number; events: KitEvent[] }>();
  for (const b of bundles) {
    if (b.status === 'cancelled' || !isExpansionBundle(b.label)) continue;
    const opp = byOpp.get(b.opportunity_id);
    if (!opp) continue;
    const kits = Number(b.kit_count) || 0;
    if (!kits) continue;
    // Prefer the close date and rep captured when the expansion was booked;
    // older bundles fall back to the insert time and the deal owner.
    const d = parseEventDate(b.sold_on ?? b.created_at ?? opp.closed_at ?? opp.created_at ?? '');
    if (Number.isNaN(d.getTime())) continue;
    const cur = expansions.get(b.opportunity_id) ?? { kits: 0, events: [] };
    cur.kits += kits;
    cur.events.push({ ownerId: b.sold_by ?? opp.owner_id, kits, date: d });
    expansions.set(b.opportunity_id, cur);
  }

  const events: KitEvent[] = [];
  for (const o of opps) {
    const exp = expansions.get(o.id);
    const total = Number(o.number_of_kits ?? 0);
    // Only subtract expansions that are actually reflected in the deal total.
    const expKits = Math.min(exp?.kits ?? 0, total);
    const base = total - expKits;
    const raw = o.closed_at ?? o.created_at;
    const d = raw ? parseEventDate(raw) : null;
    if (base > 0 && d && !Number.isNaN(d.getTime())) {
      events.push({ ownerId: o.owner_id, kits: base, date: d });
    }
    if (exp && expKits > 0) {
      // Scale down proportionally in the (rare) case the deal total lags behind.
      const factor = expKits / exp.kits;
      for (const e of exp.events) {
        const kits = Math.round(e.kits * factor);
        if (kits > 0) events.push({ ...e, kits });
      }
    }
  }
  return events;
}

/** Fetch closed-won deals plus their expansion bundles as a kit event list. Mirrors src/lib/kitEvents.ts's fetchKitEvents. */
export async function fetchKitEvents(): Promise<KitEvent[]> {
  await ensureAuthed();
  const [opps, bundles] = await Promise.all([
    supabase
      .from('opportunities')
      .select('id, owner_id, number_of_kits, closed_at, created_at')
      .eq('stage', 'closed_won')
      .eq('is_test', false),
    supabase
      .from('activation_bundles')
      .select('opportunity_id, label, kit_count, status, created_at, sold_by, sold_on')
      .not('label', 'is', null),
  ]);
  if (opps.error) throw new Error(`opportunities query failed: ${opps.error.message}`);
  if (bundles.error) throw new Error(`activation_bundles query failed: ${bundles.error.message}`);
  return buildKitEvents((opps.data ?? []) as OpportunityRow[], (bundles.data ?? []) as ExpansionBundleRow[]);
}

/** Replicates the dashboard's compute(): totals per rep with Former rollup and weekly caps. */
export function computeBreakdown(
  rows: KitEvent[],
  names: Map<string, string>,
  now: Date = new Date(),
): Breakdown {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekStart = startOfWeek(now);

  const byRep = new Map<string, RepStat>();
  const resolve = (rawId: string) => {
    const name = names.get(rawId);
    if (!name || /taisha/i.test(name)) return { id: 'former', name: 'Former' };
    return { id: rawId, name };
  };
  const get = (rawId: string) => {
    const { id, name } = resolve(rawId);
    let rep = byRep.get(id);
    if (!rep) {
      rep = { id, name, total: 0, month: 0, week: 0 };
      byRep.set(id, rep);
    }
    return rep;
  };

  for (const row of rows) {
    const kits = row.kits;
    if (!kits) continue;
    const d = row.date;
    if (!d || Number.isNaN(d.getTime())) continue;

    const rep = get(row.ownerId ?? 'former');
    rep.total += kits;
    if (d >= monthStart) rep.month += kits;
    if (d >= weekStart) rep.week += kits;
  }

  for (const [id, cap] of Object.entries(WEEKLY_KIT_OVERRIDES)) {
    const rep = byRep.get(id);
    if (rep) rep.week = Math.min(rep.week, cap);
  }

  const reps = Array.from(byRep.values()).sort((a, b) => b.total - a.total || b.month - a.month);
  const team = reps.reduce(
    (acc, r) => ({ total: acc.total + r.total, month: acc.month + r.month, week: acc.week + r.week }),
    { total: 0, month: 0, week: 0 },
  );

  // Marker changes whenever a deal is added, edited, re-staged, or expanded.
  const latest = rows.reduce<string>((max, r) => {
    const t = r.date.toISOString();
    return t > max ? t : max;
  }, '');
  const totalKits = rows.reduce((sum, r) => sum + r.kits, 0);
  const marker = `${rows.length}:${totalKits}:${latest}`;

  return { reps, team, marker };
}

export async function fetchBreakdown(): Promise<Breakdown> {
  await ensureAuthed();
  const [events, team] = await Promise.all([fetchKitEvents(), supabase.rpc('list_team')]);
  if (team.error) throw new Error(`list_team query failed: ${team.error.message}`);

  const names = new Map<string, string>();
  for (const m of (team.data ?? []) as TeamMember[]) {
    if (m?.user_id) names.set(m.user_id, m.display_name || m.email || 'Unknown rep');
  }
  return computeBreakdown(events, names);
}

// ---------------------------------------------------------------------------
// "Kits live — activation queue" (mirrors KitsLiveExecHeader.tsx)
// ---------------------------------------------------------------------------

export interface LiveLineDetail {
  /** Service line id — used to detect exactly which kits newly went live. */
  id: string;
  company: string;
  rep: string;
  /** Whole days from the deal's closed-won date to activation; null if unknown. */
  days: number | null;
}

export interface ActivationStats {
  totalLive: number;
  thisWeek: number;
  thisMonth: number;
  scheduledThisMonth: number;
  unscheduled: number;
  /** One entry per live kit, with company / rep / close→live days. */
  liveLines: LiveLineDetail[];
  /** Average close→live days across all live kits (1 decimal); null if unknown. */
  avgDaysToLive: number | null;
  /** Changes whenever the set of live kits changes. */
  marker: string;
}

interface LineRow {
  id?: string;
  activation_id: string | null;
  status: string;
  activated_at: string | null;
  created_at: string | null;
}

interface BundleRow {
  opportunity_id: string;
  kit_count: number | null;
  scheduled_date: string;
  status: string;
}

interface ActRow {
  id: string;
  opportunity_id: string;
  opportunities: {
    number_of_kits: number | null;
    name?: string | null;
    closed_at?: string | null;
    created_at?: string | null;
    owner_id?: string | null;
    owner_name?: string | null;
  } | null;
}

/** Parses a plain `YYYY-MM-DD` date as local time — same as the dashboard. */
export function parseDateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function computeActivationStats(
  lines: LineRow[],
  bundles: BundleRow[],
  acts: ActRow[],
  names: Map<string, string> = new Map(),
  now: Date = new Date(),
): ActivationStats {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const weekStart = startOfWeek(now);

  const actById = new Map(acts.map((a) => [a.id, a]));
  const liveByActivation = new Map<string, number>();
  const liveLines: LiveLineDetail[] = [];
  let totalLive = 0;
  let thisWeek = 0;
  let thisMonth = 0;
  let latest = '';

  for (const l of lines) {
    if (l.status !== 'activated') continue;
    totalLive += 1;
    if (l.activation_id) {
      liveByActivation.set(l.activation_id, (liveByActivation.get(l.activation_id) ?? 0) + 1);
    }
    const raw = l.activated_at ?? l.created_at;

    // Company / rep / close→live days via activation → opportunity.
    const opp = l.activation_id ? actById.get(l.activation_id)?.opportunities : null;
    let days: number | null = null;
    const closedRaw = opp?.closed_at ?? opp?.created_at;
    if (raw && closedRaw) {
      const activated = parseDateOnly(raw);
      const closed = parseDateOnly(closedRaw);
      if (activated && closed) {
        days = Math.max(Math.round((activated.getTime() - closed.getTime()) / 86_400_000), 0);
      }
    }
    liveLines.push({
      id: l.id ?? `${l.activation_id}:${raw}`,
      company: opp?.name || 'Unknown company',
      rep: (opp?.owner_id ? names.get(opp.owner_id) : undefined) || opp?.owner_name || 'Unknown rep',
      days,
    });

    if (!raw) continue;
    if (raw > latest) latest = raw;
    const d = parseDateOnly(raw);
    if (!d) continue;
    if (d >= monthStart) thisMonth += 1;
    if (d >= weekStart) thisWeek += 1;
  }

  const knownDays = liveLines.map((l) => l.days).filter((d): d is number => d !== null);
  const avgDaysToLive =
    knownDays.length > 0
      ? Math.round((knownDays.reduce((a, b) => a + b, 0) / knownDays.length) * 10) / 10
      : null;

  const scheduledByOpp = new Map<string, number>();
  let scheduledThisMonth = 0;
  for (const b of bundles) {
    if (b.status === 'cancelled') continue;
    const kits = Number(b.kit_count ?? 0);
    scheduledByOpp.set(b.opportunity_id, (scheduledByOpp.get(b.opportunity_id) ?? 0) + kits);
    const d = parseDateOnly(b.scheduled_date);
    if (d && d >= monthStart && d < nextMonthStart) scheduledThisMonth += kits;
  }

  // Unscheduled = kits sold that are neither already live nor covered by a schedule.
  let unscheduled = 0;
  for (const a of acts) {
    const sold = Number(a.opportunities?.number_of_kits ?? 0);
    const sched = scheduledByOpp.get(a.opportunity_id) ?? 0;
    const live = liveByActivation.get(a.id) ?? 0;
    unscheduled += Math.max(sold - live - sched, 0);
  }

  return {
    totalLive,
    thisWeek,
    thisMonth,
    scheduledThisMonth,
    unscheduled,
    liveLines,
    avgDaysToLive,
    marker: `${totalLive}:${latest}`,
  };
}

export async function fetchActivationStats(): Promise<ActivationStats> {
  await ensureAuthed();
  const [lines, bundles, acts, team] = await Promise.all([
    supabase
      .from('activation_service_lines')
      .select('id, activation_id, status, activated_at, created_at'),
    supabase.from('activation_bundles').select('opportunity_id, kit_count, scheduled_date, status'),
    supabase
      .from('activations')
      .select(
        'id, opportunity_id, opportunities(number_of_kits, name, closed_at, created_at, owner_id, owner_name, is_test)',
      ),
    supabase.rpc('list_team'),
  ]);
  if (lines.error) throw new Error(`activation_service_lines query failed: ${lines.error.message}`);
  if (bundles.error) throw new Error(`activation_bundles query failed: ${bundles.error.message}`);
  if (acts.error) throw new Error(`activations query failed: ${acts.error.message}`);

  const names = new Map<string, string>();
  for (const m of (team.data ?? []) as TeamMember[]) {
    if (m?.user_id) names.set(m.user_id, m.display_name || m.email || 'Unknown rep');
  }
  // Test deals (ops flow testing) are flagged is_test in the CRM and excluded by
  // the dashboard — drop their activations, service lines, and schedules too.
  const allActs = (acts.data ?? []) as unknown as Array<ActRow & { opportunities: (ActRow['opportunities'] & { is_test?: boolean | null }) | null }>;
  const realActs = allActs.filter((a) => !a.opportunities?.is_test);
  const realActIds = new Set(realActs.map((a) => a.id));
  const realOppIds = new Set(realActs.map((a) => a.opportunity_id));
  return computeActivationStats(
    ((lines.data ?? []) as LineRow[]).filter((l) => !l.activation_id || realActIds.has(l.activation_id)),
    ((bundles.data ?? []) as BundleRow[]).filter((b) => realOppIds.has(b.opportunity_id)),
    realActs,
    names,
  );
}
