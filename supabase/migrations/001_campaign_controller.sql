create schema if not exists campaign_ctrl;

revoke all on schema campaign_ctrl from public, anon, authenticated;

create table if not exists campaign_ctrl.control (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  pause_reason text,
  paused_at timestamptz,
  active_campaign_id integer,
  active_run_date date,
  updated_at timestamptz not null default now()
);

insert into campaign_ctrl.control (id)
values (true)
on conflict (id) do nothing;

create table if not exists campaign_ctrl.campaigns (
  campaign_id integer primary key,
  audience_json text,
  snapshot_at timestamptz,
  suppressed_json text not null default '[]',
  completed_at timestamptz,
  final_trace_count integer,
  processed_count integer not null default 0,
  remaining_count integer,
  failure_count_observed integer not null default 0,
  last_batch_at timestamptz,
  last_failures jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists campaign_ctrl.run_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  level text not null,
  event text not null,
  details jsonb
);

revoke all on all tables in schema campaign_ctrl from public, anon, authenticated;
revoke all on all sequences in schema campaign_ctrl from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets where name = 'formes_campaign_controller_key'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'formes_campaign_controller_key',
      'Internal authentication key for FORMES campaign controller cron'
    );
  end if;
end $$;
