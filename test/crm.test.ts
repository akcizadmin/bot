import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOSED_WON_GROUP_JID = 'closedwon@g.us';
process.env.ACTIVATION_GROUP_JID = 'activation@g.us';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-key';
process.env.CRM_BOT_EMAIL = 'bot@test.local';
process.env.CRM_BOT_PASSWORD = 'test-password';
const { computeBreakdown, buildKitEvents, computeActivationStats, startOfWeek, WEEKLY_KIT_OVERRIDES } =
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
    { ownerId: 'rep-a', kits: 10, date: new Date(iso(2026, 3, 1)) }, // April — total only
    { ownerId: 'rep-a', kits: 3, date: new Date(iso(2026, 7, 2)) },  // Aug 2 (Sun) — month, not week
    { ownerId: 'rep-a', kits: 2, date: new Date(iso(2026, 7, 5)) },  // Aug 5 (Wed) — month + week
    { ownerId: 'rep-b', kits: 7, date: new Date(iso(2026, 7, 4)) },
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
    { ownerId: 'rep-t', kits: 2, date: new Date(iso(2026, 5, 1)) }, // Taisha
    { ownerId: 'ghost', kits: 1, date: new Date(iso(2026, 5, 2)) }, // not in team list
    { ownerId: null, kits: 4, date: new Date(iso(2026, 5, 3)) },    // unassigned
  ];
  const b = computeBreakdown(rows, NAMES, NOW);
  assert.equal(b.reps.length, 1);
  assert.deepEqual(b.reps[0], { id: 'former', name: 'Former', total: 7, month: 0, week: 0 });
});

test('weekly overrides are empty by default, matching the dashboard (KitsExecHeader.tsx)', () => {
  // The CRM cleared this once Robert's kit-count data was fixed — the bot's
  // copy has to stay empty too, or its "this week" number silently diverges
  // from what app.akciz.com shows.
  assert.deepEqual(WEEKLY_KIT_OVERRIDES, {});
  const rows = [{ ownerId: 'rep-a', kits: 9, date: new Date(iso(2026, 7, 5)) }]; // in-week
  const b = computeBreakdown(rows, NAMES, NOW);
  assert.equal(b.reps[0].week, 9); // nothing configured — no cap applied
});

test('weekly override mechanism still caps this-week if a rep is ever configured again', () => {
  WEEKLY_KIT_OVERRIDES['rep-a'] = 5;
  try {
    const rows = [{ ownerId: 'rep-a', kits: 9, date: new Date(iso(2026, 7, 5)) }]; // in-week
    const b = computeBreakdown(rows, NAMES, NOW);
    assert.equal(b.reps[0].week, 5); // capped
    assert.equal(b.reps[0].total, 9); // total untouched
  } finally {
    delete WEEKLY_KIT_OVERRIDES['rep-a'];
  }
});

test('startOfWeek is Monday 00:00', () => {
  const monday = startOfWeek(new Date(2026, 7, 6)); // Thu Aug 6
  assert.deepEqual([monday.getDay(), monday.getHours()], [1, 0]);
  assert.equal(monday.getDate(), 3);
});

test('marker moves when deals change; shouldPost gates correctly', () => {
  const rows = [{ ownerId: 'rep-a', kits: 3, date: new Date(iso(2026, 7, 2)) }];
  const before = computeBreakdown(rows, NAMES, NOW).marker;
  const after = computeBreakdown(
    [...rows, { ownerId: 'rep-b', kits: 1, date: new Date(iso(2026, 7, 6)) }],
    NAMES,
    NOW,
  ).marker;
  assert.notEqual(before, after);
  assert.equal(shouldPost(null, before), false); // first run: silent
  assert.equal(shouldPost(before, before), false); // unchanged: silent
  assert.equal(shouldPost(before, after), true); // new deal: post
});

// ---------------------------------------------------------------------------
// buildKitEvents — mirrors src/lib/kitEvents.ts. This is the piece that was
// missing entirely before: expansion kits (bought after the deal's original
// close) need to land in the week/month they were actually sold, not the
// close date, or the bot's numbers quietly drift from the dashboard's.
// ---------------------------------------------------------------------------

test('buildKitEvents dates expansion kits by when the expansion was booked, not the original close', () => {
  const opps = [
    { id: 'opp-1', owner_id: 'rep-a', number_of_kits: 5, closed_at: iso(2026, 2, 1), created_at: null }, // closed March 1
  ];
  const bundles = [
    {
      opportunity_id: 'opp-1',
      label: 'Expansion +3 kits',
      kit_count: 3,
      status: 'scheduled',
      created_at: iso(2026, 7, 1),
      sold_by: null,
      sold_on: '2026-08-02',
    },
  ];
  const events = buildKitEvents(opps, bundles);
  assert.equal(events.length, 2);
  const base = events.find((e) => e.kits === 2);
  const exp = events.find((e) => e.kits === 3);
  assert.ok(base, 'base event (5 - 3 expansion kits) present');
  assert.ok(exp, 'expansion event present');
  assert.equal(base!.date.getMonth(), 2); // still March — the original close date
  assert.deepEqual([exp!.date.getFullYear(), exp!.date.getMonth(), exp!.date.getDate()], [2026, 7, 2]); // sold_on, parsed as local Aug 2
  assert.equal(exp!.ownerId, 'rep-a'); // sold_by unset — falls back to the deal owner
});

test('buildKitEvents ignores cancelled bundles and bundles that are not expansions', () => {
  const opps = [{ id: 'opp-1', owner_id: 'rep-a', number_of_kits: 4, closed_at: iso(2026, 7, 1), created_at: null }];
  const bundles = [
    { opportunity_id: 'opp-1', label: 'Expansion +2 kits', kit_count: 2, status: 'cancelled', created_at: iso(2026, 7, 10), sold_by: null, sold_on: null },
    { opportunity_id: 'opp-1', label: 'Install visit', kit_count: 1, status: 'scheduled', created_at: iso(2026, 7, 10), sold_by: null, sold_on: null },
  ];
  const events = buildKitEvents(opps, bundles);
  assert.equal(events.length, 1);
  assert.equal(events[0].kits, 4); // neither bundle recognized as a live expansion — full total stays on the close date
});

test('buildKitEvents scales expansion kits down if bookings exceed the deal total', () => {
  const opps = [{ id: 'opp-1', owner_id: 'rep-a', number_of_kits: 3, closed_at: iso(2026, 7, 1), created_at: null }];
  const bundles = [
    { opportunity_id: 'opp-1', label: 'Expansion +5 kits', kit_count: 5, status: 'scheduled', created_at: iso(2026, 7, 10), sold_by: 'rep-b', sold_on: null },
  ];
  const events = buildKitEvents(opps, bundles);
  // expansion kits are capped at the deal total (3), so no separate base event, and
  // the expansion event itself is scaled 5 -> 3 rather than double-counting.
  assert.equal(events.length, 1);
  assert.equal(events[0].kits, 3);
  assert.equal(events[0].ownerId, 'rep-b');
});

test('buildKitEvents skips bundles for opportunities that are not in the closed-won set', () => {
  const opps = [{ id: 'opp-1', owner_id: 'rep-a', number_of_kits: 2, closed_at: iso(2026, 7, 1), created_at: null }];
  const bundles = [
    { opportunity_id: 'opp-unknown', label: 'Expansion +1 kits', kit_count: 1, status: 'scheduled', created_at: iso(2026, 7, 10), sold_by: null, sold_on: null },
  ];
  const events = buildKitEvents(opps, bundles);
  assert.equal(events.length, 1);
  assert.equal(events[0].kits, 2);
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
      { ownerId: 'rep-a', kits: 5, date: new Date(iso(2026, 7, 5)) },
      { ownerId: 'rep-b', kits: 3, date: new Date(iso(2026, 7, 4)) },
    ],
    NAMES,
    NOW,
  );
  const text = renderLeaderboard(b);
  assert.match(text, /🥇 Robert Gonzalez — \*5\* kits/);
  assert.match(text, /🥈 Manolo Solorza — \*3\* kits/);
  assert.match(text, /Team: \*8\* all time/);
});
