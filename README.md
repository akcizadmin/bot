# Starlink Sales Leaderboard Bot (v2 — CRM-driven)

Runs on the Mac mini. Watches the **Akciz Connect CRM** (Lovable app at app.akciz.com, Supabase project `qqmivcilgpgzinldpipn`) for newly closed deals, and posts the **"Sales rep breakdown — kits sold"** leaderboard to the **$Closed-Won$** WhatsApp group through Dan's WhatsApp account (linked companion device).

- **Trigger:** any change to closed-won opportunities (new deal, edited kit count) → board posts within ~30s.
- **On demand:** type `!leaderboard` in $Closed-Won$.
- The numbers replicate the CRM dashboard exactly (`SalesRepExecPanel.tsx`): `opportunities` where `stage = 'closed_won'`, kits from `number_of_kits`, dated by `closed_at` (falling back to `created_at`), names via the `list_team` RPC, unknown/Taisha rolled into "Former", **including the dashboard's hardcoded weekly cap on Robert** (`WEEKLY_KIT_OVERRIDES` in `src/crm.ts` — keep in sync with the CRM's `KitsExecHeader.tsx`; remove in both places once the CRM data is cleaned).
- v1 (chat-message parsing + local SQLite) was removed; the old database file `data/leaderboard.db` remains on disk as an archive only.

## Setup

1. `npm install`
2. `.env` needs three values (two are pre-filled): the $Closed-Won$ group JID, the Supabase URL, and the **service_role key** from supabase.com → project `qqmivcilgpgzinldpipn` → Settings → API. Treat the key like a master password.
3. First run links WhatsApp via QR (`npm start`, scan from the phone). Credentials persist in `auth/`.
4. `npm start` to run in foreground; `npm test` for the unit tests.

## Always-on (launchd)

```sh
cp com.akciz.starlink-leaderboard.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.akciz.starlink-leaderboard.plist
```

Logs: `~/Library/Logs/starlink-leaderboard.log`. Restart: `launchctl kickstart -k gui/$(id -u)/com.akciz.starlink-leaderboard`. Stop: `launchctl bootout gui/$(id -u)/com.akciz.starlink-leaderboard`.

## Notes

- First poll after deploy records the current state silently (no post) — it only posts on *changes* from then on.
- `data/state.json` holds the last-seen change marker; delete it to force the next poll to re-baseline (still silent).
- The Mac must not sleep (System Settings → Energy), and the linked phone needs internet at least every ~14 days.
