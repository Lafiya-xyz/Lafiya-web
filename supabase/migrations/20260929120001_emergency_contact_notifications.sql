-- Issue #542: let a responder holding a capability-share link notify the
-- patient's listed emergency contacts, only when the patient has explicitly
-- opted in. No health data is included in the notification itself (built by
-- the application from a template) — this migration only adds the consent
-- purpose, the abuse-resistant server-side gate, and a privacy-safe audit
-- trail; it does not send anything itself.

-- Patient opt-in reuses the existing consent-purpose machinery (see
-- 20260821120000_governed_record_lifecycle.sql) rather than inventing a
-- parallel flag, so it gets the same profile UI, history, and withdrawal
-- semantics as every other purpose for free.
alter table public.consent_purposes drop constraint consent_purpose_name;
alter table public.consent_purposes add constraint consent_purpose_name check (purpose in (
  'account_processing', 'emergency_public_disclosure', 'offline_caching',
  'clinical_verification', 'optional_analytics', 'emergency_contact_notification'
));

insert into public.consent_purposes(purpose, version, required, description) values
  ('emergency_contact_notification', 1, false,
   'Allow a responder holding your emergency card link to notify your listed emergency contacts that you are receiving care.');

-- Privacy-safe audit trail: mirrors card_access_events (no health data, no
-- contact phone/email, no message body). Drives both the 30-minute abuse
-- limit and the patient-facing "notifications sent" summary.
create table public.emergency_contact_notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capability_id uuid references public.emergency_capabilities(id) on delete set null,
  facility_name text check (facility_name is null or char_length(facility_name) <= 120),
  sent_at timestamptz not null default now()
);
create index emergency_contact_notification_events_owner_idx
  on public.emergency_contact_notification_events(user_id, sent_at desc);

alter table public.emergency_contact_notification_events enable row level security;
create policy emergency_contact_notification_events_select_own
  on public.emergency_contact_notification_events for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.emergency_contact_notification_events from anon, authenticated;
grant select on public.emergency_contact_notification_events to authenticated;
grant select, insert, update, delete on public.emergency_contact_notification_events to service_role;

-- Server-side gate for the whole feature. Called anonymously from the
-- public capability-card route (same trust model as consume_emergency_capability),
-- so every abuse check lives here, not in the client:
--   - the capability must be active (not revoked/expired) -- a dead link
--     can't be replayed to spam contacts;
--   - proof-of-presence: last_resolved_at (set by consume_emergency_capability
--     on every live card view) must be within the last 15 minutes, so a
--     photo of a QR code alone -- without ever loading the card -- can't
--     trigger a notification;
--   - the patient must have active consent for BOTH public disclosure and
--     this purpose specifically;
--   - at most one notification per patient per 30 minutes.
-- It returns the patient's emergency contacts (already disclosed to this
-- same responder by consume_emergency_capability on the card itself) so the
-- caller can build and send the templated message; it never returns any
-- other clinical field.
create function public.notify_emergency_contacts(
  p_token_digest text, p_facility_name text default null
) returns table (
  allowed boolean, reason text, contacts jsonb, patient_first_name text
) language plpgsql security definer set search_path = '' as $$
declare
  v_capability public.emergency_capabilities;
  v_contacts jsonb;
  v_name text;
  v_last_sent timestamptz;
begin
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    return query select false, 'NOT_FOUND'::text, null::jsonb, null::text;
    return;
  end if;
  if p_facility_name is not null and char_length(p_facility_name) > 120 then
    return query select false, 'INVALID_INPUT'::text, null::jsonb, null::text;
    return;
  end if;

  select * into v_capability from public.emergency_capabilities
    where token_digest = p_token_digest for update;

  if not found or v_capability.revoked_at is not null or v_capability.expires_at <= now() then
    return query select false, 'NOT_FOUND'::text, null::jsonb, null::text;
    return;
  end if;

  if v_capability.last_resolved_at is null
     or v_capability.last_resolved_at < now() - interval '15 minutes' then
    return query select false, 'PRESENCE_REQUIRED'::text, null::jsonb, null::text;
    return;
  end if;

  if not public.has_active_consent(v_capability.user_id, 'emergency_public_disclosure')
     or not public.has_active_consent(v_capability.user_id, 'emergency_contact_notification') then
    return query select false, 'NOT_OPTED_IN'::text, null::jsonb, null::text;
    return;
  end if;

  select sent_at into v_last_sent from public.emergency_contact_notification_events
    where user_id = v_capability.user_id order by sent_at desc limit 1;
  if v_last_sent is not null and v_last_sent > now() - interval '30 minutes' then
    return query select false, 'RATE_LIMITED'::text, null::jsonb, null::text;
    return;
  end if;

  select p.emergency_contacts,
    case when (p.disclosure_policy#>>'{fields,name}')::boolean then p.name end
  into v_contacts, v_name
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  where p.user_id = v_capability.user_id
    and r.lifecycle_state not in ('suspended','revoked','deleted');

  if not found or v_contacts is null or jsonb_array_length(v_contacts) = 0 then
    return query select false, 'NO_CONTACTS'::text, null::jsonb, null::text;
    return;
  end if;

  -- Same 90-day retention discipline as card_access_events: enforced here
  -- so a missed external cron can't make this table permanent.
  delete from public.emergency_contact_notification_events where sent_at < now() - interval '90 days';
  insert into public.emergency_contact_notification_events(user_id, capability_id, facility_name)
    values (v_capability.user_id, v_capability.id, p_facility_name);

  return query select true, 'OK'::text, v_contacts, nullif(split_part(coalesce(v_name, ''), ' ', 1), '');
end;
$$;

create function public.get_my_emergency_contact_notification_summary()
returns table (notifications_last_30_days bigint, last_sent_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select count(*) filter (where sent_at >= now() - interval '30 days'), max(sent_at)
  from public.emergency_contact_notification_events where user_id = auth.uid();
$$;

revoke all on function public.notify_emergency_contacts(text, text),
  public.get_my_emergency_contact_notification_summary() from public;
grant execute on function public.notify_emergency_contacts(text, text) to anon, authenticated;
grant execute on function public.get_my_emergency_contact_notification_summary() to authenticated;

comment on function public.notify_emergency_contacts(text, text) is
  'Abuse-resistant, consent-gated notification trigger for Issue #542. Does not send anything itself -- callers must dispatch through the application-layer template/send function and record no PHI.';
comment on table public.emergency_contact_notification_events is
  'Retained for 90 days; stores only owner, capability surrogate, optional facility name, and time. No contact phone/email, message body, or health data.';
