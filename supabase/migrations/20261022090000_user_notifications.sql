-- user_notifications: in-app inbox of security/access events (#764).
--
-- Rows are written by the outbox dispatcher (service_role) through
-- record_user_notification(), which is idempotent per event_key so an outbox
-- retry never produces a duplicate. Content is PHI-free by construction:
-- only a fixed event type and a localization key are stored, never rendered
-- text, identifiers, IPs or exact device details.
--
-- Retention: rows older than 180 days are removed by
-- purge_old_user_notifications(); rows cascade-delete with the auth user.
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_key text not null unique check (char_length(event_key) between 1 and 200),
  type text not null
    check (type in ('new_sign_in', 'mfa_change', 'data_export', 'card_rotation', 'break_glass_access')),
  body_key text not null check (body_key ~ '^[a-z0-9_.]{1,100}$'),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists user_notifications_user_idx
  on public.user_notifications (user_id, created_at desc);

alter table public.user_notifications enable row level security;

create policy user_notifications_select_own
  on public.user_notifications
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Owners may only mark their own rows read; column grants below restrict
-- updates to read_at.
create policy user_notifications_update_own
  on public.user_notifications
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.user_notifications from anon, authenticated;
grant select on public.user_notifications to authenticated;
grant update (read_at) on public.user_notifications to authenticated;
grant select, insert, update, delete on public.user_notifications to service_role;

-- Idempotent write used by the outbox handler. The recipient is resolved
-- from the card's public id so outbox payloads never carry raw user ids.
create or replace function public.record_user_notification(
  p_card_public_id text,
  p_type text,
  p_body_key text,
  p_event_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_rows integer;
begin
  select user_id into v_user from public.profiles where card_public_id = p_card_public_id;
  if v_user is null then
    return false;
  end if;
  insert into public.user_notifications (user_id, event_key, type, body_key)
  values (v_user, p_event_key, p_type, p_body_key)
  on conflict (event_key) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.record_user_notification(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_user_notification(text, text, text, text) to service_role;

create or replace function public.purge_old_user_notifications()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with deleted as (
    delete from public.user_notifications
    where created_at < now() - interval '180 days'
    returning 1
  )
  select count(*)::integer from deleted;
$$;

revoke all on function public.purge_old_user_notifications() from public, anon, authenticated;
grant execute on function public.purge_old_user_notifications() to service_role;

alter publication supabase_realtime add table public.user_notifications;
