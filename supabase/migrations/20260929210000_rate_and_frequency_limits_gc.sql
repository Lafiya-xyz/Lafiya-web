-- Issue #514: rows in rate_limits and frequency_limits are otherwise never
-- removed except by a *successful* sign-in (see recordSuccess in
-- lib/rate-limit.ts, which deletes its own key on success -- frequency_limits
-- has no equivalent at all). Every key is attacker-controlled cardinality
-- (an IP, an email, a user id) on the hot sign-in/upload path, so an
-- attacker who never succeeds -- spraying unique emails/IPs, or just
-- uploading from many accounts -- can grow both tables indefinitely.
--
-- frequency_limits' window length (p_window_seconds) is supplied fresh by
-- the caller on every check-and-increment call and was never stored on the
-- row itself, so a row's own true expiry (window_start + its window length)
-- could not previously be computed from the row alone. Storing it is a
-- prerequisite for garbage collection here, not an unrelated schema change --
-- without it, a GC condition can only guess at a window length, and guessing
-- too short would purge (and thus silently reset) an active, not-yet-expired
-- counter.

alter table public.frequency_limits
  add column if not exists window_seconds integer not null default 60;

comment on column public.frequency_limits.window_seconds is
  'The p_window_seconds this row''s window was opened with (see frequency_limit_check_and_increment). Stored so purge_expired_limits() can compute this row''s true expiry (window_start + window_seconds) without guessing -- window length varies by caller (lib/frequency-limit.ts callers each pass their own).';

create or replace function public.frequency_limit_check_and_increment(
  p_key text,
  p_max_count integer,
  p_window_seconds integer
)
returns table (allowed boolean, count integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
begin
  insert into public.frequency_limits as fl (key, window_start, count, window_seconds)
  values (p_key, v_now, 1, p_window_seconds)
  on conflict (key) do update
    set window_start = case
          when fl.window_start + (p_window_seconds * interval '1 second') <= v_now
            then v_now
          else fl.window_start
        end,
        count = case
          when fl.window_start + (p_window_seconds * interval '1 second') <= v_now
            then 1
          else fl.count + 1
        end,
        -- The window length is a call-site policy, not row state -- always
        -- refresh it to whatever this call passed, exactly like window_start
        -- and count above, so a purge computed from it reflects the current
        -- caller's policy rather than whatever the very first writer of this
        -- key happened to pass.
        window_seconds = p_window_seconds
  returning fl.window_start, fl.count into v_window_start, v_count;

  return query select
    v_count <= p_max_count,
    v_count,
    case
      when v_count <= p_max_count then 0
      else greatest(
        0,
        ceil(extract(epoch from (v_window_start + (p_window_seconds * interval '1 second') - v_now)))
      )::integer
    end;
end;
$$;

comment on function public.frequency_limit_check_and_increment(text, integer, integer) is
  'Atomically increments the request count for a fixed window of p_window_seconds on p_key, resetting the window once it elapses, and returns whether this attempt is within p_max_count along with a retry_after_seconds hint. A single INSERT ... ON CONFLICT DO UPDATE so concurrent callers for the same key never lose an increment. Also persists p_window_seconds onto the row (see the window_seconds column) so purge_expired_limits() can compute this row'' true expiry.';

-- Issue #514: index the columns purge_expired_limits()'s WHERE clauses
-- filter on, so it can find "up to N expired rows" via an index scan rather
-- than a full sequential scan -- the difference between a bounded,
-- millisecond lookup and one that gets slower as these attacker-influenced
-- tables grow.
create index if not exists rate_limits_updated_at_idx
  on public.rate_limits (updated_at);

create index if not exists frequency_limits_window_start_idx
  on public.frequency_limits (window_start);

-- Batched, lock-friendly cleanup for both tables. Returns how many rows it
-- removed from each, for the caller (a cron job or the fallback route below)
-- to log.
--
-- Batching (limit p_batch_size, one DELETE per table per call) rather than
-- one unbounded DELETE is what keeps each call fast and short-lived even
-- against a multi-million-row backlog: `ctid in (select ctid ... limit n)`
-- plans as an index scan capped at n rows, so the DELETE only ever locks
-- those n rows -- not a lock proportional to how many rows in total match
-- the WHERE clause. Call this repeatedly (the scheduled job below does, and
-- so should the documented fallback) until it returns (0, 0) to fully drain
-- a large backlog rather than assuming one call is enough.
--
-- Expiry definitions (deliberately conservative -- see "Active lockouts are
-- never purged early" in the issue):
--   rate_limits: not currently locked out (blocked_until is null or has
--     already passed) AND idle for over an hour (updated_at that old). The
--     1-hour idle grace is well past the 900s (15 min) maximum lockout this
--     table ever sets, so a row can only match this condition once its own
--     lockout -- if it ever had one -- is long over.
--   frequency_limits: its own window (window_start + window_seconds) ended
--     over an hour ago -- the same grace period, for the same reason: a
--     fixed-window counter's row is never "active" once its window has
--     closed, since the next increment for that key opens a fresh window
--     unconditionally (see frequency_limit_check_and_increment above).
create or replace function public.purge_expired_limits(p_batch_size integer default 1000)
returns table (rate_limits_purged integer, frequency_limits_purged integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate_limits_purged integer;
  v_frequency_limits_purged integer;
begin
  delete from public.rate_limits
  where ctid in (
    select ctid from public.rate_limits
    where (blocked_until is null or blocked_until < now())
      and updated_at < now() - interval '1 hour'
    limit p_batch_size
  );
  get diagnostics v_rate_limits_purged = row_count;

  delete from public.frequency_limits
  where ctid in (
    select ctid from public.frequency_limits
    where window_start + (window_seconds * interval '1 second') < now() - interval '1 hour'
    limit p_batch_size
  );
  get diagnostics v_frequency_limits_purged = row_count;

  return query select v_rate_limits_purged, v_frequency_limits_purged;
end;
$$;

comment on function public.purge_expired_limits(integer) is
  'Batched cleanup for rate_limits and frequency_limits (Issue #514): removes up to p_batch_size expired rows from each table per call, never touching an active lockout/window. Returns how many rows it removed from each table. Scheduled every 5 minutes via pg_cron when available (see the DO block immediately below); on a Supabase project/tier or local dev environment without the pg_cron extension, call it instead via the authenticated POST /api/internal/purge-expired-limits fallback route on the same schedule from an external scheduler -- see docs/environment-variables.md for PURGE_LIMITS_CRON_SECRET.';

-- No grant to anon/authenticated: called only via the service-role client
-- (the fallback route) or by pg_cron running as the migration role, neither
-- of which is reachable from the browser.
revoke all on function public.purge_expired_limits(integer) from public;

-- Issue #514: schedule the batched purge every 5 minutes -- but only if
-- pg_cron is actually available. It is not on every Supabase plan/tier, and
-- is not installed at all in a local `supabase start` dev/CI instance, so
-- unconditionally calling `create extension pg_cron` here would fail this
-- entire migration (and every migration after it) in exactly those
-- environments. Catching the exception and falling through to a notice
-- instead lets local dev/CI keep working unchanged; production environments
-- that do have pg_cron available get the schedule automatically; anywhere
-- else, purge_expired_limits() still exists and works, it just needs to be
-- invoked externally (see the fallback route/doc pointers in the function
-- comment above).
do $$
begin
  create extension if not exists pg_cron;
exception
  when others then
    raise notice 'pg_cron unavailable in this environment (%); purge_expired_limits() will not be scheduled automatically -- invoke it externally instead (see docs/environment-variables.md)', sqlerrm;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- cron.schedule upserts by job name in the pg_cron versions Supabase
    -- ships, so re-running this migration (or a future one that touches the
    -- schedule) updates the existing job rather than erroring on a
    -- duplicate name.
    perform cron.schedule(
      'purge-expired-limits',
      '*/5 * * * *',
      'select public.purge_expired_limits(1000);'
    );
  else
    raise notice 'pg_cron extension not installed; purge_expired_limits() must be scheduled externally (see docs/environment-variables.md)';
  end if;
end;
$$;
