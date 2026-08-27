import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLOSED_WON_GROUP_JID = 'closedwon@g.us';
process.env.ACTIVATION_GROUP_JID = 'activation@g.us';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-key';
process.env.CRM_BOT_EMAIL = 'bot@test.local';
process.env.CRM_BOT_PASSWORD = 'test-password';

const repsPath = join(mkdtempSync(join(tmpdir(), 'reps-test-')), 'reps.json');
writeFileSync(
  repsPath,
  JSON.stringify({
    admin: { name: 'Dan', phone: '52 1 555-000-0000' },
    reps: [{ name: 'Robert Gonzalez', crmUserId: 'uuid-r', phone: '5215500000001' }],
  }),
);
process.env.REPS_FILE = repsPath;

const { loadReps, deliveryJid, repByJid } = await import('../src/agents/reps.ts');
const { coachIsDue } = await import('../src/scheduler.ts');

test('reps registry derives JIDs and strips formatting from phones', () => {
  const registry = loadReps();
  assert.ok(registry);
  assert.equal(registry.admin.jid, '5215550000000@s.whatsapp.net');
  assert.equal(registry.reps[0].jid, '5215500000001@s.whatsapp.net');
  assert.equal(repByJid('5215500000001@s.whatsapp.net')?.name, 'Robert Gonzalez');
  assert.equal(repByJid('9999@s.whatsapp.net'), null);
});

test('test mode routes rep DMs to the admin with a prefix', () => {
  const registry = loadReps()!;
  process.env.AGENT_TEST_MODE = '1';
  const testRoute = deliveryJid(registry.reps[0], registry);
  assert.equal(testRoute.jid, registry.admin.jid);
  assert.match(testRoute.prefix, /\[TEST → Robert Gonzalez\]/);
  process.env.AGENT_TEST_MODE = '0';
  const liveRoute = deliveryJid(registry.reps[0], registry);
  assert.equal(liveRoute.jid, registry.reps[0].jid);
  assert.equal(liveRoute.prefix, '');
  process.env.AGENT_TEST_MODE = '1';
});

test('mexican numbers get both 52/521 candidates', async () => {
  const { mxVariants } = await import('../src/handlers.ts');
  assert.deepEqual(mxVariants('529842766630'), ['529842766630', '5219842766630']);
  assert.deepEqual(mxVariants('5219842766630'), ['5219842766630', '529842766630']);
  assert.deepEqual(mxVariants('16103291557'), ['16103291557']); // US number untouched
});

test('coach fires weekday mornings once per day', () => {
  const tueEight = new Date(2026, 7, 11, 8, 5); // Tue Aug 11
  assert.equal(coachIsDue(tueEight, undefined), true);
  assert.equal(coachIsDue(tueEight, '2026-08-11'), false); // already ran today
  assert.equal(coachIsDue(tueEight, '2026-08-10'), true); // ran yesterday
  assert.equal(coachIsDue(new Date(2026, 7, 11, 7, 59), undefined), false); // too early
  assert.equal(coachIsDue(new Date(2026, 7, 11, 19, 0), undefined), false); // evening: outside the 8-12 window (e.g. bot was down)
  assert.equal(coachIsDue(new Date(2026, 7, 9, 10, 0), undefined), false); // Sunday
  assert.equal(coachIsDue(new Date(2026, 7, 8, 10, 0), undefined), false); // Saturday
});
