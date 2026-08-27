// Fulfillment bot: tells Ilse when to prepare for / purchase Starlink kits.
//  - a deal enters `negotiation`  → 🔔 heads-up (likely coming, check stock)
//  - a deal enters `closed_won`   → ✅ ORDER NOW (full purchase details)
//  - Ilse replies "comprado <company>" → marked purchased
//  - weekday morning summary of everything still unpurchased
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAuthed, supabase } from '../crm.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const statePath = process.env.FULFILLMENT_STATE_PATH ?? join(projectRoot, 'data', 'fulfillment-state.json');

export interface FulfillmentDeal {
  id: string;
  name: string | null;
  stage: string;
  number_of_kits: number | null;
  kit_type: string | null;
  data_plan: string | null;
  connection_type: string | null;
  street_address: string | null;
  desired_activation_date: string | null;
  estimated_install_date: string | null;
  owner_name: string | null;
  owner_id: string | null;
  closed_at: string | null;
  updated_at: string | null;
}

interface FulfillmentState {
  /** deal id → last stage we notified about ('negotiation' | 'closed_won') */
  notified: Record<string, string>;
  /** deal id → ISO time Ilse confirmed purchase */
  purchased: Record<string, string>;
  /** activation id → true once we've posted its shipped notice */
  shippedNotified: Record<string, boolean>;
  /** activation id → true once we've posted its go-live closure in this group */
  liveNotified: Record<string, boolean>;
  lastSummaryDate?: string;
  baselined?: boolean;
  lifecycleBaselined?: boolean;
}

export function readState(): FulfillmentState {
  const empty: FulfillmentState = { notified: {}, purchased: {}, shippedNotified: {}, liveNotified: {} };
  try {
    return { ...empty, ...(JSON.parse(readFileSync(statePath, 'utf8')) as Partial<FulfillmentState>) };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: purchase → shipped → scheduled → live, per won deal
// ---------------------------------------------------------------------------

export interface ActivationInfo {
  id: string;
  opportunity_id: string;
  status: string; // 'pending' | 'activated'
  shipping_confirmed: boolean | null;
  shipped_at: string | null;
  shipping_reference: string | null;
  activation_date: string | null;
  liveLines: number; // activated service lines
  scheduledDate: string | null; // earliest non-cancelled bundle date
}

export async function fetchActivationInfo(): Promise<Map<string, ActivationInfo>> {
  await ensureAuthed();
  const [acts, lines, bundles] = await Promise.all([
    supabase
      .from('activations')
      .select('id, opportunity_id, status, shipping_confirmed, shipped_at, shipping_reference, activation_date, opportunities!inner(is_test)')
      .eq('opportunities.is_test', false),
    supabase.from('activation_service_lines').select('activation_id, status'),
    supabase.from('activation_bundles').select('opportunity_id, scheduled_date, status'),
  ]);
  if (acts.error) throw new Error(`activations query failed: ${acts.error.message}`);
  if (lines.error) throw new Error(`activation_service_lines query failed: ${lines.error.message}`);
  if (bundles.error) throw new Error(`activation_bundles query failed: ${bundles.error.message}`);

  const liveByAct = new Map<string, number>();
  for (const l of (lines.data ?? []) as Array<{ activation_id: string | null; status: string }>) {
    if (l.status === 'activated' && l.activation_id) liveByAct.set(l.activation_id, (liveByAct.get(l.activation_id) ?? 0) + 1);
  }
  const schedByOpp = new Map<string, string>();
  for (const b of (bundles.data ?? []) as Array<{ opportunity_id: string; scheduled_date: string; status: string }>) {
    if (b.status === 'cancelled' || !b.scheduled_date) continue;
    const prev = schedByOpp.get(b.opportunity_id);
    if (!prev || b.scheduled_date < prev) schedByOpp.set(b.opportunity_id, b.scheduled_date);
  }

  // Keyed by opportunity id (one activation per deal in practice).
  const byOpp = new Map<string, ActivationInfo>();
  for (const a of (acts.data ?? []) as Array<Omit<ActivationInfo, 'liveLines' | 'scheduledDate'>>) {
    byOpp.set(a.opportunity_id, {
      ...a,
      liveLines: liveByAct.get(a.id) ?? 0,
      scheduledDate: schedByOpp.get(a.opportunity_id) ?? null,
    });
  }
  return byOpp;
}

export type LifecycleStage = 'por_comprar' | 'comprado' | 'enviado' | 'programado' | 'activado';

/** Where a won deal sits in the fulfillment lifecycle. Exported for tests. */
export function lifecycleStage(deal: FulfillmentDeal, act: ActivationInfo | undefined, state: FulfillmentState): LifecycleStage {
  const kits = Number(deal.number_of_kits ?? 0);
  if (act && (act.status === 'activated' || (kits > 0 && act.liveLines >= kits))) return 'activado';
  if (act?.scheduledDate) return 'programado';
  if (act && (act.shipped_at || act.shipping_confirmed || act.shipping_reference)) return 'enviado';
  if (state.purchased[deal.id]) return 'comprado';
  return 'por_comprar';
}

const STAGE_LABEL: Record<LifecycleStage, string> = {
  por_comprar: '🛒 Por comprar',
  comprado: '✅ Comprado',
  enviado: '📦 Enviado',
  programado: '📅 Programado',
  activado: '🟢 Activado',
};

export function renderShippedNotice(deal: FulfillmentDeal, act: ActivationInfo): string {
  return [
    `📦 *Enviado — ${deal.name ?? 'Deal sin nombre'}*`,
    '',
    `📦 ${kitsLabel(deal)}`,
    `🚚 Guía: ${act.shipping_reference ?? '—'}${act.shipped_at ? ` · enviado ${fmtDate(act.shipped_at)}` : ''}`,
    `📅 Instalación programada: ${fmtDate(act.scheduledDate)}`,
    `📍 ${deal.street_address ?? '⚠️ sin dirección en el CRM'}`,
    `👤 Vendedor: ${deal.owner_name ?? '—'}`,
  ].join('\n');
}

export function renderLifecycleTracker(
  deals: FulfillmentDeal[],
  acts: Map<string, ActivationInfo>,
  state: FulfillmentState,
): string {
  const won = deals.filter((d) => d.stage === 'closed_won');
  const groups: Record<LifecycleStage, FulfillmentDeal[]> = {
    por_comprar: [], comprado: [], enviado: [], programado: [], activado: [],
  };
  for (const d of won) groups[lifecycleStage(d, acts.get(d.id), state)].push(d);
  const kits = (list: FulfillmentDeal[]) => list.reduce((s, d) => s + Number(d.number_of_kits ?? 0), 0);

  const lines = ['🔎 *Tracker de fulfillment* (deals ganados)', ''];
  for (const stage of ['por_comprar', 'comprado', 'enviado', 'programado'] as LifecycleStage[]) {
    const list = groups[stage];
    lines.push(`${STAGE_LABEL[stage]}: *${list.length}* deals · ${kits(list)} kits`);
    for (const d of list.slice(0, 8)) {
      const act = acts.get(d.id);
      const extra =
        stage === 'programado' && act?.scheduledDate ? ` · instala ${fmtDate(act.scheduledDate)}`
        : stage === 'enviado' && act?.shipping_reference ? ` · guía ${act.shipping_reference}`
        : '';
      lines.push(`  • ${d.name ?? '?'} — ${kitsLabel(d)}${extra}`);
    }
    if (list.length > 8) lines.push(`  …y ${list.length - 8} más`);
  }
  lines.push(`${STAGE_LABEL.activado}: *${groups.activado.length}* deals · ${kits(groups.activado)} kits`);
  return lines.join('\n');
}

export function writeState(state: FulfillmentState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

const DEAL_FIELDS =
  'id, name, stage, number_of_kits, kit_type, data_plan, connection_type, street_address, desired_activation_date, estimated_install_date, owner_name, owner_id, closed_at, updated_at';

export async function fetchFulfillmentDeals(names: Map<string, string>): Promise<FulfillmentDeal[]> {
  await ensureAuthed();
  const { data, error } = await supabase
    .from('opportunities')
    .select(DEAL_FIELDS)
    .in('stage', ['negotiation', 'closed_won'])
    .eq('is_test', false)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(`fulfillment deals query failed: ${error.message}`);
  return ((data ?? []) as FulfillmentDeal[]).map((d) => ({
    ...d,
    owner_name: (d.owner_id ? names.get(d.owner_id) : undefined) || d.owner_name,
  }));
}

/** Which deals need a new notice, given what we already told Ilse. Exported for tests. */
export function pendingNotices(deals: FulfillmentDeal[], state: FulfillmentState): FulfillmentDeal[] {
  return deals.filter((d) => {
    const last = state.notified[d.id];
    if (d.stage === 'closed_won') return last !== 'closed_won';
    if (d.stage === 'negotiation') return last === undefined;
    return false;
  });
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function kitsLabel(d: FulfillmentDeal): string {
  const n = Number(d.number_of_kits ?? 0);
  return `${n} kit${n === 1 ? '' : 's'}${d.kit_type ? ` ${d.kit_type}` : ''}`;
}

export function renderNotice(d: FulfillmentDeal): string {
  const target = d.desired_activation_date ?? d.estimated_install_date;
  if (d.stage === 'closed_won') {
    return [
      `✅ *ORDENAR AHORA — ${d.name ?? 'Deal sin nombre'}*`,
      '',
      `📦 ${kitsLabel(d)}`,
      `📡 Plan: ${d.data_plan ?? '—'} · Conexión: ${d.connection_type ?? '—'}`,
      `📍 Envío: ${d.street_address ?? '⚠️ sin dirección en el CRM'}`,
      `📅 Activación deseada: ${fmtDate(target)}`,
      `👤 Vendedor: ${d.owner_name ?? '—'}`,
      `🗓️ Cerrado: ${fmtDate(d.closed_at)}`,
      '',
      `Cuando esté comprado responde: *comprado ${d.name ?? ''}*`.trim(),
    ].join('\n');
  }
  return [
    `🔔 *Heads-up — ${d.name ?? 'Deal sin nombre'} está en negociación*`,
    '',
    `📦 Probable: ${kitsLabel(d)}`,
    `📡 Plan: ${d.data_plan ?? '—'} · Conexión: ${d.connection_type ?? '—'}`,
    `📅 Activación deseada: ${fmtDate(target)}`,
    `👤 Vendedor: ${d.owner_name ?? '—'}`,
    '',
    '_Aún NO comprar — solo revisar stock y tiempos de entrega. Avisaré cuando cierre._',
  ].join('\n');
}

export function renderSummary(deals: FulfillmentDeal[], state: FulfillmentState): string {
  const toBuy = deals.filter((d) => d.stage === 'closed_won' && !state.purchased[d.id]);
  const coming = deals.filter((d) => d.stage === 'negotiation');
  const kits = (list: FulfillmentDeal[]) => list.reduce((s, d) => s + Number(d.number_of_kits ?? 0), 0);

  const lines = ['📋 *Resumen de fulfillment*', ''];
  lines.push(`✅ *Por comprar:* ${toBuy.length} deal${toBuy.length === 1 ? '' : 's'} · ${kits(toBuy)} kits`);
  for (const d of toBuy.slice(0, 15)) {
    lines.push(`  • ${d.name ?? '?'} — ${kitsLabel(d)} · ${d.owner_name ?? '—'} · cerrado ${fmtDate(d.closed_at)}`);
  }
  if (toBuy.length > 15) lines.push(`  …y ${toBuy.length - 15} más`);
  lines.push('', `🔔 *En negociación:* ${coming.length} deal${coming.length === 1 ? '' : 's'} · ${kits(coming)} kits probables`);
  lines.push('', 'Responde *comprado <empresa>* para marcar como comprado.');
  return lines.join('\n');
}

/** Match "comprado <company>" against unpurchased closed-won deals. Exported for tests. */
export function matchPurchaseReply(text: string, deals: FulfillmentDeal[], state: FulfillmentState): FulfillmentDeal[] | null {
  const m = /^\s*(?:comprado|comprada|purchased|bought)\s+(.+)$/i.exec(text);
  if (!m) return null;
  const needle = m[1].trim().toLowerCase();
  const candidates = deals.filter((d) => d.stage === 'closed_won' && !state.purchased[d.id]);
  const exact = candidates.filter((d) => (d.name ?? '').toLowerCase() === needle);
  if (exact.length) return exact;
  return candidates.filter((d) => (d.name ?? '').toLowerCase().includes(needle));
}
