// Rep registry: maps CRM user ids to names and WhatsApp JIDs.
// Loaded from reps.json (gitignored — contains phone numbers). Shape:
//   { "admin": { "name": "Dan", "phone": "521..." },
//     "reps": [{ "name": "Robert Gonzalez", "crmUserId": "uuid", "phone": "521..." }] }
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Rep {
  name: string;
  crmUserId: string;
  phone: string; // digits only, country code included
  jid: string; // derived: <phone>@s.whatsapp.net
}

export interface RepRegistry {
  admin: Rep; // Dan — receives admin digests and all DMs while in test mode
  reps: Rep[];
}

function toJid(phone: string): string {
  return `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

/** A phone is usable once it has a real number in it (placeholders like "PUT-PHONE" are not). */
function phoneOk(phone: string): boolean {
  return phone.replace(/[^0-9]/g, '').length >= 8;
}

let cached: RepRegistry | null | undefined;

/** Returns the registry, or null if reps.json doesn't exist yet (agents stay off). */
export function loadReps(): RepRegistry | null {
  if (cached !== undefined) return cached;
  try {
    const raw = JSON.parse(readFileSync(process.env.REPS_FILE ?? join(projectRoot, 'reps.json'), 'utf8')) as {
      admin: { name: string; phone: string; crmUserId?: string };
      reps: Array<{ name: string; crmUserId: string; phone: string }>;
    };
    if (!phoneOk(raw.admin.phone)) {
      console.warn('reps.json: admin phone not filled in — sales agents stay off.');
      cached = null;
      return cached;
    }
    const configured = raw.reps.filter((r) => phoneOk(r.phone));
    const missing = raw.reps.filter((r) => !phoneOk(r.phone)).map((r) => r.name);
    if (missing.length) console.warn(`reps.json: no phone yet for ${missing.join(', ')} — they are skipped.`);
    cached = {
      admin: {
        name: raw.admin.name,
        crmUserId: raw.admin.crmUserId ?? '',
        phone: raw.admin.phone,
        jid: toJid(raw.admin.phone),
      },
      reps: configured.map((r) => ({ ...r, jid: toJid(r.phone) })),
    };
  } catch {
    cached = null;
  }
  return cached;
}

/** Where a message for `rep` should actually go, honoring test mode. */
export function deliveryJid(rep: Rep, registry: RepRegistry): { jid: string; prefix: string } {
  if (process.env.AGENT_TEST_MODE !== '0') {
    return { jid: registry.admin.jid, prefix: `[TEST → ${rep.name}]\n` };
  }
  return { jid: rep.jid, prefix: '' };
}

export function repByJid(jid: string): Rep | null {
  const registry = loadReps();
  if (!registry) return null;
  if (registry.admin.jid === jid) return registry.admin;
  return registry.reps.find((r) => r.jid === jid) ?? null;
}
