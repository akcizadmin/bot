import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOSED_WON_GROUP_JID = 'closedwon@g.us';
process.env.ACTIVATION_GROUP_JID = 'activation@g.us';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-key';
process.env.CRM_BOT_EMAIL = 'bot@test.local';
process.env.CRM_BOT_PASSWORD = 'test-password';
const { pendingNotices, renderNotice, renderSummary, matchPurchaseReply, lifecycleStage, renderLifecycleTracker, renderShippedNotice } =
  await import('../src/agents/fulfillment.ts');
const EMPTY_STATE = { notified: {}, purchased: {}, shippedNotified: {}, liveNotified: {} };

const deal = (over: Record<string, unknown>) => ({
  id: 'x',
  name: 'Hotel Mara',
  stage: 'closed_won',
  number_of_kits: 3,
  kit_type: 'Standard',
  data_plan: '500GB',
  connection_type: 'Fixed',
  street_address: 'Av. Reforma 1, CDMX',
  desired_activation_date: '2026-08-20',
  estimated_install_date: null,
  owner_name: 'Robert Gonzalez',
  owner_id: 'r1',
  closed_at: '2026-08-10T15:00:00Z',
  updated_at: '2026-08-10T15:00:00Z',
  ...over,
});

test('two-step notices: negotiation once, closed_won once, never twice', () => {
  const deals = [
    deal({ id: 'a', stage: 'negotiation' }),
    deal({ id: 'b', stage: 'closed_won' }),
    deal({ id: 'c', stage: 'closed_won' }),
  ];
  const state = { ...EMPTY_STATE, notified: { b: 'closed_won', c: 'negotiation' } };
  const pending = pendingNotices(deals, state).map((d) => d.id);
  assert.deepEqual(pending, ['a', 'c']); // a: new heads-up; c: moved negotiation → won; b: already told
});

test('closed-won notice carries every purchase detail', () => {
  const text = renderNotice(deal({}));
  assert.match(text, /ORDENAR AHORA — Hotel Mara/);
  assert.match(text, /3 kits Standard/);
  assert.match(text, /Plan: 500GB · Conexión: Fixed/);
  assert.match(text, /Av\. Reforma 1, CDMX/);
  assert.match(text, /Activación deseada: 20\/08\/2026/);
  assert.match(text, /Vendedor: Robert Gonzalez/);
  assert.match(text, /comprado Hotel Mara/);
});

test('missing address is flagged instead of blank', () => {
  assert.match(renderNotice(deal({ street_address: null })), /sin dirección en el CRM/);
});

test('negotiation notice says do not buy yet', () => {
  const text = renderNotice(deal({ stage: 'negotiation' }));
  assert.match(text, /Heads-up — Hotel Mara/);
  assert.match(text, /Aún NO comprar/);
});

test('purchase reply matches exact, then partial, and rejects unknown', () => {
  const deals = [deal({ id: 'a', name: 'Hotel Mara' }), deal({ id: 'b', name: 'Hotel Mara Norte' }), deal({ id: 'c', name: 'Gramer' })];
  const state = EMPTY_STATE;
  assert.deepEqual(matchPurchaseReply('comprado Hotel Mara', deals, state)?.map((d) => d.id), ['a']); // exact wins
  assert.deepEqual(matchPurchaseReply('Comprado hotel', deals, state)?.map((d) => d.id), ['a', 'b']); // ambiguous
  assert.deepEqual(matchPurchaseReply('comprado zzz', deals, state), []);
  assert.equal(matchPurchaseReply('hola', deals, state), null); // not a confirmation
  assert.deepEqual(matchPurchaseReply('comprado gramer', deals, { ...EMPTY_STATE, purchased: { c: 'x' } }), []); // already bought
});

test('summary separates to-buy from coming, excludes purchased', () => {
  const deals = [deal({ id: 'a' }), deal({ id: 'b', name: 'Gramer', number_of_kits: 20 }), deal({ id: 'n', stage: 'negotiation', number_of_kits: 50 })];
  const text = renderSummary(deals, { ...EMPTY_STATE, purchased: { b: 'x' } });
  assert.match(text, /Por comprar:\* 1 deal · 3 kits/);
  assert.match(text, /Hotel Mara/);
  assert.doesNotMatch(text, /Gramer/);
  assert.match(text, /En negociación:\* 1 deal · 50 kits/);
});

const act = (over: Record<string, unknown>) => ({
  id: 'act-1',
  opportunity_id: 'x',
  status: 'pending',
  shipping_confirmed: null,
  shipped_at: null,
  shipping_reference: null,
  activation_date: null,
  liveLines: 0,
  scheduledDate: null,
  ...over,
});

test('lifecycle stage progresses purchase → shipped → scheduled → live', () => {
  const d = deal({ number_of_kits: 3 });
  assert.equal(lifecycleStage(d, undefined, EMPTY_STATE), 'por_comprar');
  assert.equal(lifecycleStage(d, undefined, { ...EMPTY_STATE, purchased: { x: 't' } }), 'comprado');
  assert.equal(lifecycleStage(d, act({ shipping_reference: 'DHL123' }), EMPTY_STATE), 'enviado');
  assert.equal(lifecycleStage(d, act({ shipped_at: '2026-08-11', scheduledDate: '2026-08-20' }), EMPTY_STATE), 'programado');
  assert.equal(lifecycleStage(d, act({ liveLines: 3 }), EMPTY_STATE), 'activado'); // all kits live
  assert.equal(lifecycleStage(d, act({ liveLines: 1, status: 'activated' }), EMPTY_STATE), 'activado'); // status wins
  assert.equal(lifecycleStage(d, act({ liveLines: 1 }), EMPTY_STATE), 'por_comprar'); // partial, unshipped, unbought
});

test('shipped notice includes tracking and install date', () => {
  const text = renderShippedNotice(deal({}), act({ shipping_reference: 'DHL123', shipped_at: '2026-08-11', scheduledDate: '2026-08-20' }));
  assert.match(text, /Enviado — Hotel Mara/);
  assert.match(text, /Guía: DHL123 · enviado 11\/08\/2026/);
  assert.match(text, /Instalación programada: 20\/08\/2026/);
});

test('tracker groups won deals by lifecycle stage', () => {
  const deals = [
    deal({ id: 'a', name: 'A Co', number_of_kits: 2 }),
    deal({ id: 'b', name: 'B Co', number_of_kits: 4 }),
    deal({ id: 'c', name: 'C Co', number_of_kits: 1 }),
    deal({ id: 'n', name: 'Neg Co', stage: 'negotiation' }), // not won → excluded
  ];
  const acts = new Map([
    ['b', act({ id: 'act-b', opportunity_id: 'b', shipping_reference: 'X1' })],
    ['c', act({ id: 'act-c', opportunity_id: 'c', status: 'activated', liveLines: 1 })],
  ]);
  const text = renderLifecycleTracker(deals, acts, EMPTY_STATE);
  assert.match(text, /🛒 Por comprar: \*1\* deals · 2 kits/);
  assert.match(text, /📦 Enviado: \*1\* deals · 4 kits/);
  assert.match(text, /B Co — 4 kits Standard · guía X1/);
  assert.match(text, /🟢 Activado: \*1\* deals · 1 kits/);
  assert.doesNotMatch(text, /Neg Co/);
});
