# FORMES Odoo Campaign Controller

Cloud-only controller for FORMĚS Odoo Email Marketing campaigns 05–39.

## Operating constraints
- No Odoo custom Python/server action.
- No change to the existing Odoo subscription.
- No dependency on a Windows PC after bootstrap.
- Uses the existing Odoo campaign definitions and configured outbound mail server.
- Processes 10 recipients per minute.
- Re-checks blacklist and mailing-list opt-out status before each batch.
- Verifies Odoo mailing traces after each batch.
- Safety-pauses on Microsoft sender restrictions (including AS(42004), restricted sender, outbound spam, 5.7.708) or 3+ failures in one batch.
- Runs only Sunday–Thursday, starting 08:00 Asia/Muscat.
- Sends at most one campaign per Oman working day.

## Runtime
Supabase Edge Function + Supabase Cron. Sensitive Odoo session data is stored only in Supabase Vault and is never committed to GitHub.

## Campaign map
Odoo mailing IDs 72–106 = Campaigns 05–39.
