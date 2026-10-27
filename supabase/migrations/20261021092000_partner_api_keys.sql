-- Issue #809: hashed, scoped partner API keys with per-key quotas and
-- usage counters. Usage rows hold only key, endpoint template, status
-- class and counts -- never record hashes, IPs or patient identifiers.

create table if not exists public.partner_api_keys (
  id uuid primary key default gen_random_uuid(),
  partner_id text not null,
  key_prefix text not null unique,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  rate_per_minute integer not null default 60 check (rate_per_minute > 0),
  monthly_quota integer not null default 100000 check (monthly_quota > 0),
  created_at timestamptz not null default now(),
  -- Set on rotation so old and new keys overlap until this instant.
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists partner_api_keys_partner_idx on public.partner_api_keys (partner_id);

create table if not exists public.partner_api_quota_windows (
  key_id uuid not null references public.partner_api_keys (id) on delete cascade,
  window_kind text not null check (window_kind in ('minute', 'month')),
  window_start timestamptz not null,
  used integer not null default 0,
  primary key (key_id, window_kind, window_start)
);

create table if not exists public.partner_api_usage (
  key_id uuid not null references public.partner_api_keys (id) on delete cascade,
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  endpoint text not null,
  status_class text not null check (status_class in ('2xx', '3xx', '4xx', '5xx')),
  count bigint not null default 0,
  primary key (key_id, period, endpoint, status_class)
);

alter table public.partner_api_keys enable row level security;
alter table public.partner_api_quota_windows enable row level security;
alter table public.partner_api_usage enable row level security;

-- Atomically consumes one unit from both the per-minute and monthly
-- windows. Row locks from INSERT ... ON CONFLICT DO UPDATE serialize
-- concurrent callers on the same key, so the quota can never be overshot.
-- A rejected request rolls its increments back (no charge for 429s).
create or replace function public.partner_api_consume(p_key_id uuid)
returns table (allowed boolean, minute_remaining integer, month_remaining integer,
               minute_reset timestamptz, month_reset timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_key public.partner_api_keys;
  v_minute timestamptz := date_trunc('minute', now());
  v_month timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_minute_used integer;
  v_month_used integer;
begin
  select * into v_key from public.partner_api_keys where id = p_key_id;
  if not found then
    raise exception 'unknown partner key';
  end if;

  insert into public.partner_api_quota_windows as w (key_id, window_kind, window_start, used)
  values (p_key_id, 'minute', v_minute, 1)
  on conflict (key_id, window_kind, window_start) do update set used = w.used + 1
  returning used into v_minute_used;

  insert into public.partner_api_quota_windows as w (key_id, window_kind, window_start, used)
  values (p_key_id, 'month', v_month, 1)
  on conflict (key_id, window_kind, window_start) do update set used = w.used + 1
  returning used into v_month_used;

  if v_minute_used > v_key.rate_per_minute or v_month_used > v_key.monthly_quota then
    update public.partner_api_quota_windows set used = used - 1
      where key_id = p_key_id
        and ((window_kind = 'minute' and window_start = v_minute)
          or (window_kind = 'month' and window_start = v_month));
    v_minute_used := v_minute_used - 1;
    v_month_used := v_month_used - 1;
    allowed := false;
  else
    allowed := true;
  end if;

  minute_remaining := greatest(0, v_key.rate_per_minute - v_minute_used);
  month_remaining := greatest(0, v_key.monthly_quota - v_month_used);
  minute_reset := v_minute + interval '1 minute';
  month_reset := v_month + interval '1 month';
  return next;
end;
$$;

create or replace function public.partner_api_record_usage(
  p_key_id uuid, p_endpoint text, p_status_class text)
returns void language sql security definer set search_path = '' as $$
  insert into public.partner_api_usage as u (key_id, period, endpoint, status_class, count)
  values (p_key_id, to_char(now() at time zone 'utc', 'YYYY-MM'), p_endpoint, p_status_class, 1)
  on conflict (key_id, period, endpoint, status_class) do update set count = u.count + 1;
$$;

revoke all on function public.partner_api_consume(uuid) from public, anon, authenticated;
revoke all on function public.partner_api_record_usage(uuid, text, text) from public, anon, authenticated;
