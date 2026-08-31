-- A responder holding an expired or revoked capability link needs to know
-- to ask the patient for a new one; a responder holding a mistyped/unknown
-- link needs to know the link itself is wrong. Both previously collapsed
-- into a single 'inactive' state. Splitting them out does not create a
-- meaningful oracle: token_digest is a SHA-256 digest of a 256-bit random
-- value (lib/emergency/capability.ts), so brute-forcing a collision with a
-- real (if now-expired) capability is computationally infeasible regardless
-- of what the response distinguishes. A malformed token, an unknown digest,
-- and a profile made unavailable through consent/lifecycle changes still
-- all collapse into 'not_found', since those aren't properties of the
-- capability itself.
create or replace function public.consume_emergency_capability(p_token_digest text)
returns table (
  access_state text,
  capability_id uuid,
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, schema_version integer, offline_cache_allowed boolean,
  trust_state public.trust_decision_state, trust_updated_at timestamptz,
  record_updated_at timestamptz, authorization_expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare v_capability public.emergency_capabilities;
begin
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    return query select 'not_found'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into v_capability from public.emergency_capabilities
    where token_digest = p_token_digest for update;

  if not found then
    return query select 'not_found'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_capability.revoked_at is not null then
    return query select 'revoked'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_capability.expires_at <= now() then
    return query select 'expired'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_capability.max_views is not null and v_capability.used_views >= v_capability.max_views then
    return query select 'exhausted'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  update public.emergency_capabilities set used_views = used_views + 1,
    last_resolved_at = now() where id = v_capability.id;

  return query
  select 'active'::text, v_capability.id,
    case when coalesce((v_capability.field_allowlist->>'name')::boolean, false)
              and (p.disclosure_policy#>>'{fields,name}')::boolean then p.name end,
    case when coalesce((v_capability.field_allowlist->>'age')::boolean, false)
              and (p.disclosure_policy#>>'{fields,age}')::boolean and p.date_of_birth is not null
      then extract(year from age(p.date_of_birth))::int end,
    case when coalesce((v_capability.field_allowlist->>'photo_url')::boolean, false)
              and (p.disclosure_policy#>>'{fields,photo_url}')::boolean then p.photo_url end,
    case when coalesce((v_capability.field_allowlist->>'blood_group')::boolean, false)
              and (p.disclosure_policy#>>'{fields,blood_group}')::boolean then p.blood_group end,
    case when coalesce((v_capability.field_allowlist->>'genotype')::boolean, false)
              and (p.disclosure_policy#>>'{fields,genotype}')::boolean then p.genotype end,
    case when coalesce((v_capability.field_allowlist->>'allergies')::boolean, false)
              and (p.disclosure_policy#>>'{fields,allergies}')::boolean then p.allergies end,
    case when coalesce((v_capability.field_allowlist->>'medications')::boolean, false)
              and (p.disclosure_policy#>>'{fields,medications}')::boolean then p.medications end,
    case when coalesce((v_capability.field_allowlist->>'chronic_conditions')::boolean, false)
              and (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean then p.chronic_conditions end,
    case when coalesce((v_capability.field_allowlist->>'emergency_contacts')::boolean, false)
              and (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean then p.emergency_contacts end,
    case when coalesce((v_capability.field_allowlist->>'language')::boolean, false)
              and (p.disclosure_policy#>>'{fields,language}')::boolean then p.language end,
    (select jsonb_object_agg(k, case when coalesce((v_capability.field_allowlist->>k)::boolean, false)
      and (v)::boolean then 'disclosed' else 'withheld' end)
      from jsonb_each_text(p.disclosure_policy->'fields') f(k,v)),
    r.schema_version, public.has_active_consent(p.user_id, 'offline_caching'),
    coalesce(td.state, 'unverified'::public.trust_decision_state), td.updated_at,
    r.created_at, v_capability.expires_at
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  left join public.trust_decisions td on td.revision_id = r.id
  where p.user_id = v_capability.user_id
    and r.lifecycle_state not in ('suspended','revoked','deleted')
    and public.has_active_consent(p.user_id, 'emergency_public_disclosure');

  -- Consent withdrawal and lifecycle changes also fail closed. Do not reveal
  -- which condition made the capability unavailable.
  if not found then
    return query select 'not_found'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
  end if;
end;
$$;
