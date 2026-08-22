-- Fix #175: expose the true profile freshness timestamp on the public
-- emergency card.
--
-- The previous definition of get_emergency_card() returned r.created_at
-- (the immutable revision-creation time) as record_updated_at. That value
-- reflects when the last governed save was committed, not when the profile
-- was most recently modified by the patient. profiles.updated_at is
-- maintained by the profiles_set_updated_at BEFORE UPDATE trigger and is
-- the canonical "when was this card last changed" value.
--
-- A responder glancing at "Record updated" should see the time the patient
-- last touched their card — not an internal revision timestamp that can
-- differ if background lifecycle transitions have run.
--
-- No column type change: record_updated_at remains timestamptz. No changes
-- to consume_emergency_capability(), EmergencyCardRow, card-content.tsx, or
-- the integration-test EXPECTED_KEYS list are required.

drop function public.get_emergency_card(uuid);

create function public.get_emergency_card(p_card_id uuid)
returns table (
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, schema_version integer, offline_cache_allowed boolean,
  trust_state public.trust_decision_state, trust_updated_at timestamptz,
  record_updated_at timestamptz, authorization_expires_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select
    case when (p.disclosure_policy#>>'{fields,name}')::boolean
      then p.name end,
    case when (p.disclosure_policy#>>'{fields,age}')::boolean
              and p.date_of_birth is not null
      then extract(year from age(p.date_of_birth))::int end,
    case when (p.disclosure_policy#>>'{fields,photo_url}')::boolean
      then p.photo_url end,
    case when (p.disclosure_policy#>>'{fields,blood_group}')::boolean
      then p.blood_group end,
    case when (p.disclosure_policy#>>'{fields,genotype}')::boolean
      then p.genotype end,
    case when (p.disclosure_policy#>>'{fields,allergies}')::boolean
      then p.allergies end,
    case when (p.disclosure_policy#>>'{fields,medications}')::boolean
      then p.medications end,
    case when (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean
      then p.chronic_conditions end,
    case when (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean
      then p.emergency_contacts end,
    case when (p.disclosure_policy#>>'{fields,language}')::boolean
      then p.language end,
    -- Full per-field disclosure map so the offline envelope can know
    -- exactly what was withheld without re-fetching.
    (select jsonb_object_agg(k, case when (v)::boolean then 'disclosed' else 'withheld' end)
       from jsonb_each_text(p.disclosure_policy->'fields') f(k, v)),
    r.schema_version,
    public.has_active_consent(p.user_id, 'offline_caching'),
    coalesce(td.state, 'unverified'::public.trust_decision_state),
    td.updated_at,
    -- Use the profile's own updated_at (maintained by the
    -- profiles_set_updated_at trigger) rather than r.created_at so that
    -- "Record updated" reflects the last time the patient actually
    -- changed their card, not an internal revision-creation time.
    p.updated_at,
    p.legacy_card_sunset_at
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  left join public.trust_decisions td on td.revision_id = r.id
  where p.card_public_id = p_card_id
    and p.legacy_card_sunset_at > now()
    and r.lifecycle_state not in ('suspended', 'revoked', 'deleted')
    and public.has_active_consent(p.user_id, 'emergency_public_disclosure');
$$;

revoke all on function public.get_emergency_card(uuid) from public;
grant execute on function public.get_emergency_card(uuid) to anon, authenticated;

comment on function public.get_emergency_card(uuid) is
  'Public, unauthenticated lookup of the emergency-relevant subset of a profile by its unguessable card_public_id. record_updated_at is profiles.updated_at (trigger-maintained), not the revision creation time. Never returns user_id, card_public_id, or auth.users data.';
