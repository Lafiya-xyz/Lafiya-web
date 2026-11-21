-- Issue #937: partner webhook delivery console.
--
-- Stores one row per delivery attempt with a REDACTED request/response
-- snapshot (no PHI, no capability tokens, no raw payload bodies), supports
-- manual replay that preserves the original idempotency key, and keeps two
-- active signing secrets per endpoint during a rotation grace period.

create table if not exists public.partner_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  partner_id text not null,
  url text not null,
  -- Only the SHA-256 of each signing secret is stored; the plaintext is
  -- shown once at creation/rotation time.
  secret_hash text not null,
  secret_prefix text not null,
  -- Set on rotation: the previous secret keeps verifying until this instant.
  previous_secret_hash text,
  previous_secret_expires_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  disabled_at timestamptz
);
create index if not exists partner_webhook_endpoints_partner_idx
  on public.partner_webhook_endpoints (partner_id);

create table if not exists public.partner_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.partner_webhook_endpoints (id) on delete cascade,
  partner_id text not null,
  event_type text not null,
  -- Preserved verbatim across replays so receivers can deduplicate.
  idempotency_key text not null,
  -- Redacted request snapshot: headers with secrets stripped, body replaced
  -- by a hash + byte length.
  request_headers jsonb not null default '{}',
  request_body_sha256 text not null,
  request_body_bytes integer not null default 0,
  response_status integer,
  response_headers jsonb not null default '{}',
  response_body_excerpt text,
  duration_ms integer,
  error text,
  attempt integer not null default 1 check (attempt >= 1),
  -- The delivery this row replays, if any.
  replayed_from uuid references public.partner_webhook_deliveries (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists partner_webhook_deliveries_endpoint_idx
  on public.partner_webhook_deliveries (endpoint_id, created_at desc);
create index if not exists partner_webhook_deliveries_partner_idx
  on public.partner_webhook_deliveries (partner_id, created_at desc);

alter table public.partner_webhook_endpoints enable row level security;
alter table public.partner_webhook_deliveries enable row level security;

-- Atomically rotates the signing secret: the current secret becomes the
-- previous one and stays valid until `p_grace_until`. Returns the new hash.
create or replace function public.partner_webhook_rotate_secret(
  p_endpoint_id uuid, p_new_hash text, p_new_prefix text, p_grace_until timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.partner_webhook_endpoints
    set previous_secret_hash = secret_hash,
        previous_secret_expires_at = p_grace_until,
        secret_hash = p_new_hash,
        secret_prefix = p_new_prefix,
        rotated_at = now()
    where id = p_endpoint_id and disabled_at is null;
  if not found then
    raise exception 'unknown or disabled webhook endpoint';
  end if;
end;
$$;

revoke all on function public.partner_webhook_rotate_secret(uuid, text, text, timestamptz)
  from public, anon, authenticated;
