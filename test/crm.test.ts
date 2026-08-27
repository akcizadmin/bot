import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOSED_WON_GROUP_JID = 'closedwon@g.us';
process.env.ACTIVATION_GROUP_JID = 'activation@g.us';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-key';
process.env.CRM_BOT_EMAIL = 'bot@test.local';
process.env.CRM_BOT_PASSWORD = 'test-password';
const { computeBreakdown, computeActivationStats, startOfWeek, WEEKLY_KIT_OVERRIDES } =
  await import('../src/crm.ts');
const { shouldPost, newlyLiveIds } = await import('../src/watcher.ts');
const { renderLeaderboard, renderActivationBoard } = await import('../src/leaderboard.ts');

// Fixed reference time: Thursday 2026-08-06. Week = Mon 2026-08-03, month = Aug 1.
const NOW = new Date(2026, 7, 6, 12, 0, 0);
const iso = (y: number, m: number, d: number) => new Date(y, m, d, 10).toISOString();

const NAMES = new Map([
  ['rep-a', 'Robert Gonzalez'],
  ['rep-b', 'Manolo Solorza'],
  ['rep-t', 'Taisha Gonzalez'],
]);

test('computes total / month / week windows like the dashboard', () => {
  const rows = [
    { owner_id: 'rep-a', number_of_kits: 10, closed_at: iso(2026, 3, 1), created_at: null }, // April — total only
    { owner_id: 'rep-a', number_of_kits: 3, closed_at: iso(2026, 7, 2), created_at: null },  // Aug 2 (Sun) — month, not week
    { owner_id: 'rep-a', number_of_kits: 2, closed_at: iso(2026, 7, 5), created_at: null },  // Aug 5 (Wed) — month + week
    { owner_id: 'rep-b', number_of_kits: 7, closed_at: null, created_at: iso(2026, 7, 4) },  // falls back to created_at
  ];
  const b = computeBreakdown(rows, NAMES, NOW);
  const robert = b.reps.find((r) => r.name === 'Robert Gonzalez');
  const manolo = b.reps.find((r) => r.name === 'Manolo Solorza');
  assert.deepEqual({ total: robert?.total, month: robert?.month, week: robert?.week }, { total: 15, month: 5, week: 2 });
  assert.deepEqual({ total: manolo?.total, month: manolo?.month, week: manolo?.week }, { total: 7, month: 7, week: 7 });
  assert.deepEqual(b.team, { total: 22, month: 12, week: 9 });
});

test('unknown owners and Taisha roll up into a single Former line', () => {
  const rows = [
    { owner_id: 'rep-t', number_of_kits: 2, closed_at: iso(2026, 5, 1), created_at: null }, // Taisha
    { owner_id: 'ghost', number_of_kits: 1, closed_at: iso(2026, 5, 2), created_at: null }, // not in team list
    { owner_id: null, number_of_kits: 4, closed_at: iso(2026, 5, 3), created_at: null },    // unassigned
  ];
  const b = computeBreakdown(rows, NAMES, NOW);
  assert.equal(b.reps.length, 1);
  assert.deepEqual(b.reps[0], { id: 'former', name: 'Former', total: 7, month: 0, week: 0 });
});

test('weekly override caps this-week for the configured rep', () => {
  const [overrideId] = Object.keys(WEEKLY_KIT_OVERRIDES);
  const names = new Map([[overrideId, 'Robert Gonzalez']]);
  const rows = [
    { owner_id: overrideId, number_of_kits: 9, closed_at: iso(2026, 7, 5), created_at: null }, // in-week
  ];
  const b = computeBreakdown(rows, names, NOW);
  assert.equal(b.reps[0].week, WEEKLY_KIT_OVERRIDES[overrideId]); // capped at 5, not 9
  assert.equal(b.reps[0].total, 9); // total untouched
});

test('startOfWeek is Monday 00:00', () => {
  const monday = startOfWeek(new Date(2026, 7, 6)); // Thu Aug 6
  assert.deepEqual([monday.getDay(), monday.getHours()], [1, 0]);
  assert.equal(monday.getDate(), 3);
});

test('marker moves when deals change; shouldPost gates correctly', () => {
  const rows = [{ owner_id: 'rep-a', number_of_kits: 3, closed_at: iso(2026, 7, 2), created_at: null }];
  const before = computeBreakdown(rows, NAMES, NOW).marker;
  const after = computeBreakdown(
    [...rows, { owner_id: 'rep-b', number_of_kits: 1, closed_at: iso(2026, 7, 6), created_at: null }],
    NAMES,
    NOW,
  ).marker;
  assert.notEqual(before, after);
  assert.equal(shouldPost(null, before), false); // first run: silent
  assert.equal(shouldPost(before, before), false); // unchanged: silent
  assert.equal(shouldPost(before, after), true); // new deal: post
});

const ACT_LINES = [
  { id: 'l1', activation_id: 'act-1', status: 'activated', activated_at: '2026-08-05', created_at: null }, // this week
  { id: 'l2', activation_id: 'act-1', status: 'activated', activated_at: '2026-08-01', created_at: null }, // month only (Sat before week)
  { id: 'l3', activation_id: 'act-2', status: 'activated', activated_at: null, created_at: '2026-07-10' }, // older, created_at fallback
  { id: 'l4', activation_id: 'act-2', status: 'pending', activated_at: null, created_at: '2026-07-10' },   // not live
];
const ACT_BUNDLES = [
  { opportunity_id: 'opp-1', kit_count: 4, scheduled_date: '2026-08-20', status: 'scheduled' }, // this month
  { opportunity_id: 'opp-1', kit_count: 2, scheduled_date: '2026-09-02', status: 'scheduled' }, // next month
  { opportunity_id: 'opp-2', kit_count: 9, scheduled_date: '2026-08-15', status: 'cancelled' }, // ignored
];
const ACT_ACTS = [
  // 10 sold - 2 live - 6 sched = 2 unscheduled; closed 2026-07-30 → l1 6 days, l2 2 days
  { id: 'act-1', opportunity_id: 'opp-1', opportunities: { number_of_kits: 10, name: 'Hotel Mara', closed_at: '2026-07-30', owner_name: 'Robert Gonzalez' } },
  // 3 sold - 1 live - 0 sched = 2 unscheduled; no closed_at/created_at → days null
  { id: 'act-2', opportunity_id: 'opp-2', opportunities: { number_of_kits: 3, name: 'Gramer', owner_name: 'Manolo Solorza' } },
];

test('activation stats mirror the kits-live dashboard math', () => {
  const s = computeActivationStats(ACT_LINES, ACT_BUNDLES, ACT_ACTS, new Map(), NOW);
  assert.deepEqual(
    { totalLive: s.totalLive, thisWeek: s.thisWeek, thisMonth: s.thisMonth, scheduled: s.scheduledThisMonth, unscheduled: s.unscheduled },
    { totalLive: 3, thisWeek: 1, thisMonth: 2, scheduled: 4, unscheduled: 4 },
  );
});

test('live lines carry company, rep, and close→live days; average computed', () => {
  const s = computeActivationStats(ACT_LINES, ACT_BUNDLES, ACT_ACTS, new Map(), NOW);
  const l1 = s.liveLines.find((l) => l.id === 'l1');
  const l3 = s.liveLines.find((l) => l.id === 'l3');
  assert.deepEqual(l1, { id: 'l1', company: 'Hotel Mara', rep: 'Robert Gonzalez', days: 6 });
  assert.deepEqual(l3, { id: 'l3', company: 'Gramer', rep: 'Manolo Solorza', days: null });
  assert.equal(s.avgDaysToLive, 4); // (6 + 2) / 2 known-days lines
});

test('activation board posts only for newly live line ids', () => {
  assert.deepEqual(newlyLiveIds(null, ['a', 'b']), []); // first baseline: silent
  assert.deepEqual(newlyLiveIds(['a', 'b'], ['a', 'b']), []); // no change
  assert.deepEqual(newlyLiveIds(['a'], ['a', 'b', 'c']), ['b', 'c']); // two went live
  assert.deepEqual(newlyLiveIds(['a', 'b'], ['a']), []); // corrections downward: silent
});

test('renders the activation board with per-kit go-live details and average', () => {
  const s = computeActivationStats(ACT_LINES, ACT_BUNDLES, ACT_ACTS, new Map(), NOW);
  const newLines = s.liveLines.filter((l) => l.id === 'l1' || l.id === 'l2');
  const text = renderActivationBoard(s, newLines);
  assert.match(text, /\+2 kits just went LIVE/);
  assert.match(text, /🏢 Hotel Mara — 2 kits · 👤 Robert Gonzalez · ⏱️ 6 days from close to live/);
  assert.match(text, /Total live: \*3\*/);
  assert.match(text, /Avg close → live: \*4\* days/);
  const noDelta = renderActivationBoard(s);
  assert.doesNotMatch(noDelta, /just went LIVE/);
});

test('renders a readable board', () => {
  const b = computeBreakdown(
    [
      { owner_id: 'rep-a', number_of_kits: 5, closed_at: iso(2026, 7, 5), created_at: null },
      { owner_id: 'rep-b', number_of_kits: 3, closed_at: iso(2026, 7, 4), created_at: null },
    ],
    NAMES,
    NOW,
  );
  const text = renderLeaderboard(b);
  assert.match(text, /🥇 Robert Gonzalez — \*5\* kits/);
  assert.match(text, /🥈 Manolo Solorza — \*3\* kits/);
  assert.match(text, /Team: \*8\* all time/);
});
