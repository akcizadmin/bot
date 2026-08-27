function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

export const config = {
  // "$Closed-Won$" group — kits-sold leaderboard is posted here
  closedWonGroupJid: required('CLOSED_WON_GROUP_JID').trim(),
  // "AcTiVaTiOn" group — kits-live board is posted here when a kit goes live
  activationGroupJid: required('ACTIVATION_GROUP_JID').trim(),
  // Fulfillment group (Ilse) — purchase heads-ups/orders; optional until created
  fulfillmentGroupJid: (process.env.FULFILLMENT_GROUP_JID ?? '').trim() || null,
  // Phones (digits, with country code) to @-mention on fulfillment posts (Ilse, Kari)
  fulfillmentMentions: (process.env.FULFILLMENT_MENTIONS ?? '')
    .split(',')
    .map((p) => p.replace(/[^0-9]/g, ''))
    .filter((p) => p.length >= 8),
  // Akciz Connect CRM (Lovable app) Supabase project — anon key is the public
  // client key; the bot authenticates as a CRM user, like the dashboard does.
  supabaseUrl: required('SUPABASE_URL').trim(),
  supabaseAnonKey: required('SUPABASE_ANON_KEY').trim(),
  crmBotEmail: required('CRM_BOT_EMAIL').trim(),
  crmBotPassword: required('CRM_BOT_PASSWORD'),
  crmPollSeconds: Number(process.env.CRM_POLL_SECONDS ?? 30),
};
