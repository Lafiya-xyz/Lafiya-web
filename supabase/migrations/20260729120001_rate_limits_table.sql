-- rate_limits: durable, cross-instance backend for the application-level
-- brute-force/credential-stuffing defense used by app/(auth)/signin/actions.ts
-- (see lib/rate-limit.ts).
--
-- Why this replaces the old in-memory Map: this app runs on Vercel, where
-- concurrent invocations of the same Server Action are not guaranteed to
-- share a process (Vercel's serverless/Fluid Compute model gives no such
-- guarantee, and actively spreads load across instances under real traffic).
-- Under credential-stuffing traffic -- many concurrent requests for the same
-- email -- attempts land on several independent serverless instances, each
-- with its own empty in-memory store, so the "lock out after 5 failures"
-- guarantee was only ever real within a single warm instance. Moving the
-- counter into the Supabase Postgres project already backing this app gives
-- every instance a single, consistent view of attempts and lockouts, with no
-- new infrastructure dependency (see PR description for the
-- Postgres-vs-Redis/Upstash tradeoff).
--
-- Atomicity: rate_limit_record_failure below is a single
-- `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement rather than a
-- SELECT + separate UPDATE. Postgres takes an exclusive row lock on the
-- conflicting row as part of the upsert itself, so N concurrent callers for
-- the same key serialize on that lock and each sees the previous caller's
-- increment -- no lost updates -- in one round trip, with no explicit
-- SELECT ... FOR UPDATE / advisory lock needed.
create table if not exists public.rate_limits (
  key text primary key,
  attempts integer not null default 0 check (attempts >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.rate_limits is
  'Durable, cross-instance state for the application-level brute-force/credential-stuffing rate limiter (lib/rate-limit.ts). Written only via the service-role client from server-only code (checkRateLimit/recordFailure/recordSuccess) -- never exposed to anon/authenticated clients.';

-- RLS enabled with no policies: default-deny for anon/authenticated, exactly
-- as chw_payouts does for its write path. Only the service role (which
-- bypasses RLS) reads/writes this table. No GRANT to anon/authenticated
-- either, so a future permissive policy mistake still wouldn't expose it via
-- PostgREST without an explicit grant too.
alter table public.rate_limits enable row level security;

-- Atomic check-and-increment for a single rate-limit key. Encodes the exact
-- backoff policy already documented on recordFailure in lib/rate-limit.ts:
-- attempts 1-4 are not locked out; attempt 5 locks for 30s; attempts 6+
-- double the lockout (30s * 2^(attempts-5)) up to a 900s (15 minute) cap.
-- Uses now() (Postgres server time) rather than a client-supplied timestamp
-- so the lockout window is computed consistently regardless of which
-- serverless instance/region called in.
create or replace function public.rate_limit_record_failure(p_key text)
returns table (attempts integer, blocked_until timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  insert into public.rate_limits as rl (key, attempts, blocked_until, updated_at)
  values (p_key, 1, null, now())
  on conflict (key) do update
    set attempts = rl.attempts + 1,
        updated_at = now(),
        blocked_until = case
          when rl.attempts + 1 >= 5
            then now() + (least(900, 30 * power(2, (rl.attempts + 1) - 5)) * interval '1 second')
          else null
        end
  returning rl.attempts, rl.blocked_until;
end;
$$;

comment on function public.rate_limit_record_failure(text) is
  'Atomically increments the failure count for a rate-limit key and (re)computes its exponential-backoff lockout (5 attempts -> 30s, doubling to a 900s cap), returning the new attempts count and blocked_until. A single INSERT ... ON CONFLICT DO UPDATE so concurrent callers for the same key never lose an increment.';

-- No grant to anon/authenticated: this function is called only via the
-- service-role client from lib/rate-limit.ts (server-only, never reachable
-- from the browser). service_role already has default privileges granted by
-- the Supabase project setup, independent of this revoke.
revoke all on function public.rate_limit_record_failure(text) from public;
