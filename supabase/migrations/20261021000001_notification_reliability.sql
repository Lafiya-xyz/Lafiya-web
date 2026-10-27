-- Notification reliability, preferences and routing (issues #802–#805).
--
-- Privacy: recipient addresses are never stored in clear. Suppressions are
-- keyed by a SHA-256 hash of the normalized email address; delivery metrics
-- keep only a country calling-code prefix and a mobile network name.

-- #802: email bounce / complaint suppression list -----------------------------
create table public.email_suppressions (
  address_hash  text        primary key,
  reason        text        not null check (reason in ('hard_bounce', 'soft_bounce', 'complaint')),
  soft_count    integer     not null default 0,
  expires_at    timestamptz,              -- null = permanent until manual release
  released_at   timestamptz,
  released_by   uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.email_suppressions enable row level security;
grant select, insert, update on public.email_suppressions to service_role;

-- #803 / #805: delivery receipts ----------------------------------------------
alter table public.notification_deliveries
  add column provider         text check (provider in ('termii', 'twilio')),
  add column delivery_state   text not null default 'pending'
    check (delivery_state in ('pending', 'accepted', 'sent', 'delivered', 'undelivered', 'failed')),
  add column country_prefix   text,       -- e.g. '234'; never the full number
  add column network          text,       -- e.g. 'mtn'; derived from prefix
  add column deliver_by       timestamptz,
  add column receipt_at       timestamptz,
  add column escalated_at     timestamptz;

create index notification_deliveries_provider_msg_idx
  on public.notification_deliveries(provider_id);
create index notification_deliveries_pending_deadline_idx
  on public.notification_deliveries(deliver_by)
  where delivery_state in ('pending', 'accepted', 'sent') and escalated_at is null;

-- #804: notification preferences ------------------------------------------------
create table public.notification_preferences (
  user_id        uuid        primary key references auth.users(id) on delete cascade,
  timezone       text        not null default 'Africa/Lagos',
  quiet_start    smallint    check (quiet_start between 0 and 1439),  -- minutes after local midnight
  quiet_end      smallint    check (quiet_end between 0 and 1439),
  channels       jsonb       not null default '{}'::jsonb,  -- { eventClass: { channel: boolean } }
  batch_low_priority boolean not null default true,
  updated_at     timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on public.notification_preferences to authenticated, service_role;

create table public.notification_preference_audit (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  before     jsonb,
  after      jsonb       not null,
  created_at timestamptz not null default now()
);

alter table public.notification_preference_audit enable row level security;
create policy notification_preference_audit_read_own on public.notification_preference_audit
  for select to authenticated using (user_id = auth.uid());
grant select on public.notification_preference_audit to authenticated;
grant select, insert on public.notification_preference_audit to service_role;
