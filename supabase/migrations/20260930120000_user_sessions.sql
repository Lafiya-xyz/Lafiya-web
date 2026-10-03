-- user_sessions: owner-visible list of where a patient is signed in, so a
-- lost or shared phone can be signed out remotely (#523).
--
-- Privacy: only a coarse browser family and OS family are stored (fixed
-- vocabularies, enforced by CHECK constraints so no raw user-agent string can
-- ever be written), plus created/last-seen timestamps. No IP address, no
-- location, no device model, no version numbers.
--
-- Lifecycle: session_id is the Supabase Auth session id (the JWT
-- `session_id` claim). The row is deleted with its auth session (FK cascade),
-- which covers sign-out, "sign out everywhere else", refresh-token revocation,
-- and account deletion. Rows whose session has expired, or has been inactive
-- beyond the refresh-token lifetime, are purged by touch_my_session() for the
-- owner and by purge_expired_user_sessions() for everyone.
create table if not exists public.user_sessions (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  browser text not null default 'Other'
    check (browser in ('Chrome', 'Edge', 'Firefox', 'Safari', 'Opera', 'Samsung Internet', 'Other')),
  os text not null default 'Other'
    check (os in ('Android', 'iOS', 'Windows', 'macOS', 'Linux', 'ChromeOS', 'Other')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists user_sessions_user_id_idx
  on public.user_sessions (user_id, last_seen_at desc);

comment on table public.user_sessions is
  'Active-session metadata for the owner''s "where you''re signed in" panel. Coarse browser/OS family and timestamps only -- never IPs or locations. Written only through touch_my_session(); rows cascade-delete with their auth.sessions row.';

alter table public.user_sessions enable row level security;

-- Owners can read their own rows. There are no insert/update/delete policies:
-- writes go through the SECURITY DEFINER functions below, which derive the
-- user and session from the caller's verified JWT rather than trusting input.
create policy user_sessions_select_own
  on public.user_sessions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.user_sessions from anon, authenticated;
grant select on public.user_sessions to authenticated;
grant select, insert, update, delete on public.user_sessions to service_role;

-- Records (or refreshes) the caller's current session. last_seen_at is only
-- rewritten when the stored value is at least five minutes old, so a burst
-- of requests produces at most one write per session per five minutes no
-- matter how many app instances call this. Returns true only when a row was
-- actually written, which lets callers and tests observe the throttle.
create or replace function public.touch_my_session(p_browser text, p_os text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_session uuid;
  v_written boolean := false;
begin
  begin
    v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    v_session := null;
  end;

  if v_user is null or v_session is null then
    return false;
  end if;

  -- Only a live session that belongs to the caller can be recorded.
  if not exists (
    select 1 from auth.sessions s
    where s.id = v_session
      and s.user_id = v_user
      and (s.not_after is null or s.not_after > now())
  ) then
    return false;
  end if;

  insert into public.user_sessions as us (session_id, user_id, browser, os)
  values (
    v_session,
    v_user,
    case when p_browser in ('Chrome', 'Edge', 'Firefox', 'Safari', 'Opera', 'Samsung Internet') then p_browser else 'Other' end,
    case when p_os in ('Android', 'iOS', 'Windows', 'macOS', 'Linux', 'ChromeOS') then p_os else 'Other' end
  )
  on conflict (session_id) do update
    set last_seen_at = now(),
        browser = excluded.browser,
        os = excluded.os
    where us.user_id = v_user
      and us.last_seen_at <= now() - interval '5 minutes'
  returning true into v_written;

  -- Opportunistically purge this owner's expired rows (runs at most once per
  -- five minutes per session because it sits behind the same throttle).
  if coalesce(v_written, false) then
    delete from public.user_sessions us
    where us.user_id = v_user
      and (
        us.last_seen_at < now() - interval '30 days'
        or not exists (
          select 1 from auth.sessions s
          where s.id = us.session_id
            and (s.not_after is null or s.not_after > now())
        )
      );
  end if;

  return coalesce(v_written, false);
end;
$$;

comment on function public.touch_my_session(text, text) is
  'Upserts the caller''s current session (from the JWT session_id claim) into user_sessions with a coarse browser/OS family. Rewrites last_seen_at at most once per 5 minutes per session; returns true only when a row was written.';

revoke all on function public.touch_my_session(text, text) from public;
grant execute on function public.touch_my_session(text, text) to authenticated;

-- Revokes one of the caller's own sessions. Deleting the auth.sessions row
-- cascades to its refresh tokens, so the revoked device cannot refresh, and
-- the Auth server rejects its still-unexpired access token on the next
-- getUser() (session_not_found), which is what proxy.ts checks on every
-- request.
create or replace function public.revoke_my_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_deleted integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  delete from auth.sessions s
  where s.id = p_session_id
    and s.user_id = v_user;
  get diagnostics v_deleted = row_count;

  -- Normally already removed by the FK cascade; kept explicit so a stale row
  -- for an already-gone session can also be cleared from the list.
  delete from public.user_sessions us
  where us.session_id = p_session_id
    and us.user_id = v_user;

  return v_deleted > 0;
end;
$$;

comment on function public.revoke_my_session(uuid) is
  'Deletes one of the caller''s own auth sessions (revoking its refresh tokens) and its user_sessions row. Sessions of other users are never affected.';

revoke all on function public.revoke_my_session(uuid) from public;
grant execute on function public.revoke_my_session(uuid) to authenticated;

-- Global purge for scheduled maintenance: removes rows whose auth session is
-- gone or past not_after, or that have been inactive longer than the 30-day
-- refresh-token lifetime. Service role only.
create or replace function public.purge_expired_user_sessions()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.user_sessions us
  where us.last_seen_at < now() - interval '30 days'
    or not exists (
      select 1 from auth.sessions s
      where s.id = us.session_id
        and (s.not_after is null or s.not_after > now())
    );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.purge_expired_user_sessions() is
  'Deletes user_sessions rows for expired, removed, or long-inactive sessions. Returns the number of rows removed. Service role only.';

revoke all on function public.purge_expired_user_sessions() from public;
grant execute on function public.purge_expired_user_sessions() to service_role;
