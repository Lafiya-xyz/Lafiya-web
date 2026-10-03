-- Notification delivery tracking table (issue #625).
--
-- Records every notification send attempt keyed by an application-generated
-- idempotencyKey.  The service uses this to suppress duplicate sends when
-- the same idempotencyKey is submitted more than once.
--
-- Privacy: recipient addresses (phone, email) are NOT stored here — they are
-- passed directly to provider SDKs.  Only the opaque idempotencyKey, channel,
-- template name, status, and a provider-assigned message ID are retained.

create table public.notification_deliveries (
  idempotency_key text        primary key,
  channel         text        not null check (channel in ('email', 'sms', 'push')),
  template        text        not null,
  status          text        not null check (status in ('sent', 'failed', 'duplicate')),
  provider_id     text,
  error_message   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.notification_deliveries is
  'Idempotency log for notification sends (issue #625). '
  'Recipient addresses are never stored — only the opaque idempotency key, '
  'channel, template, and delivery status.';

create index notification_deliveries_created_idx
  on public.notification_deliveries(created_at desc);

-- RLS: service role only — the notification service runs server-side with
-- the service role key.  Authenticated clients have no access.
alter table public.notification_deliveries enable row level security;

grant select, insert, update on public.notification_deliveries to service_role;
