-- Run once after the Edge Function is deployed and the Odoo session is bootstrapped.
-- 04:00–09:59 UTC = 08:00–13:59 Asia/Muscat, Sunday–Thursday.

select cron.schedule(
  'formes-odoo-campaign-controller',
  '* 4-9 * * 0-4',
  $$
  select net.http_post(
    url := 'https://ilyttcuuorwvgpvkyxqg.supabase.co/functions/v1/formes-odoo-campaign-controller',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Controller-Key', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'formes_campaign_controller_key'
        order by created_at desc
        limit 1
      )
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 15000
  ) as request_id;
  $$
);
