// Read-only CRM queries used by the sales agents. All scoped per rep.
import { ensureAuthed, supabase } from '../crm.ts';

export interface LeadLite {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  phone: string | null;
  status: string | null;
  lead_score: number | null;
  estimated_kits: number | null;
  deal_size_mxn: number | null;
  industry: string | null;
  city: string | null;
  use_case: string | null;
  pain_summary: string | null;
  ai_business_summary: string | null;
  ai_starlink_angle: string | null;
  next_step_date: string | null;
  next_step_description: string | null;
  owner_assigned_at: string | null;
}

export interface DealLite {
  id: string;
  name: string | null;
  stage: string | null;
  amount_mxn: number | null;
  number_of_kits: number | null;
  next_step_date: string | null;
  next_step_description: string | null;
  updated_at: string | null;
}

export interface RepPipeline {
  untouched: LeadLite[]; // assigned, no next step planned — going cold
  dueOrOverdue: LeadLite[]; // next_step_date today or past
  staleDeals: DealLite[]; // open deals untouched for 7+ days or with no/past next step
  openDealCount: number;
}

const LEAD_FIELDS =
  'id, company_name, contact_name, phone, status, lead_score, estimated_kits, deal_size_mxn, industry, city, use_case, pain_summary, ai_business_summary, ai_starlink_angle, next_step_date, next_step_description, owner_assigned_at';

export async function fetchRepPipeline(crmUserId: string, now: Date = new Date()): Promise<RepPipeline> {
  await ensureAuthed();
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const [untouched, due, deals] = await Promise.all([
    supabase
      .from('leads')
      .select(LEAD_FIELDS)
      .eq('owner_id', crmUserId)
      .is('disqualified_at', null)
      .is('converted_account_id', null)
      .is('next_step_date', null)
      .order('owner_assigned_at', { ascending: true, nullsFirst: false })
      .limit(25),
    supabase
      .from('leads')
      .select(LEAD_FIELDS)
      .eq('owner_id', crmUserId)
      .is('disqualified_at', null)
      .is('converted_account_id', null)
      .lte('next_step_date', today)
      .order('next_step_date', { ascending: true })
      .limit(15),
    supabase
      .from('opportunities')
      .select('id, name, stage, amount_mxn, number_of_kits, next_step_date, next_step_description, updated_at')
      .eq('owner_id', crmUserId)
      .eq('is_test', false)
      .not('stage', 'in', '(closed_won,closed_lost)')
      .limit(50),
  ]);
  if (untouched.error) throw new Error(`leads (untouched) query failed: ${untouched.error.message}`);
  if (due.error) throw new Error(`leads (due) query failed: ${due.error.message}`);
  if (deals.error) throw new Error(`opportunities query failed: ${deals.error.message}`);

  const openDeals = (deals.data ?? []) as DealLite[];
  const staleDeals = openDeals.filter(
    (d) =>
      (d.updated_at !== null && d.updated_at < weekAgo) ||
      d.next_step_date === null ||
      d.next_step_date <= today,
  );

  return {
    untouched: (untouched.data ?? []) as LeadLite[],
    dueOrOverdue: (due.data ?? []) as LeadLite[],
    staleDeals,
    openDealCount: openDeals.length,
  };
}

export interface UnassignedSummary {
  totalUnassignedNew: number;
  topUnassigned: LeadLite[];
}

/** For Dan's admin digest: the size and cream of the unowned lead pool. */
export async function fetchUnassignedSummary(): Promise<UnassignedSummary> {
  await ensureAuthed();
  const [count, top] = await Promise.all([
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .is('owner_id', null)
      .is('disqualified_at', null)
      .is('converted_account_id', null),
    supabase
      .from('leads')
      .select(LEAD_FIELDS)
      .is('owner_id', null)
      .is('disqualified_at', null)
      .is('converted_account_id', null)
      .order('deal_size_mxn', { ascending: false, nullsFirst: false })
      .limit(5),
  ]);
  if (top.error) throw new Error(`unassigned leads query failed: ${top.error.message}`);
  return {
    totalUnassignedNew: count.count ?? 0,
    topUnassigned: (top.data ?? []) as LeadLite[],
  };
}
