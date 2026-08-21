-- Responders receive the latest persisted trust decision for the exact
-- revision, never a boolean inferred from an RPC success. Legacy revisions
-- marked verified before evidence persistence degrade to unavailable.

drop function public.get_emergency_card(uuid);
create function public.get_emergency_card(p_card_id uuid)
returns table (
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, revision_id uuid, schema_version integer,
  commitment text, trust_status text, offline_cache_allowed boolean
) language sql stable security definer set search_path='' as $$
  select
    case when (p.disclosure_policy#>>'{fields,name}')::boolean then p.name end,
    case when (p.disclosure_policy#>>'{fields,age}')::boolean and p.date_of_birth is not null
      then extract(year from age(p.date_of_birth))::int end,
    case when (p.disclosure_policy#>>'{fields,photo_url}')::boolean then p.photo_url end,
    case when (p.disclosure_policy#>>'{fields,blood_group}')::boolean then p.blood_group end,
    case when (p.disclosure_policy#>>'{fields,genotype}')::boolean then p.genotype end,
    case when (p.disclosure_policy#>>'{fields,allergies}')::boolean then p.allergies end,
    case when (p.disclosure_policy#>>'{fields,medications}')::boolean then p.medications end,
    case when (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean then p.chronic_conditions end,
    case when (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean then p.emergency_contacts end,
    case when (p.disclosure_policy#>>'{fields,language}')::boolean then p.language end,
    (select jsonb_object_agg(k, case when (v)::boolean then 'disclosed' else 'withheld' end)
       from jsonb_each_text(p.disclosure_policy->'fields') f(k,v)),
    r.id, r.schema_version, r.commitment,
    coalesce((
      select e.decision from public.verification_trust_events e
      where e.revision_id=r.id
      order by e.observed_at desc, e.id desc limit 1
    ), case when r.lifecycle_state='verified' then 'unavailable' else 'unverified' end),
    public.has_active_consent(p.user_id,'offline_caching')
  from public.profiles p join public.record_revisions r on r.id=p.current_revision_id
  where p.card_public_id=p_card_id
    and r.lifecycle_state not in ('suspended','revoked','deleted')
    and public.has_active_consent(p.user_id,'emergency_public_disclosure');
$$;
revoke all on function public.get_emergency_card(uuid) from public;
grant execute on function public.get_emergency_card(uuid) to anon,authenticated;

comment on function public.get_emergency_card(uuid) is
  'Versioned, consent-gated emergency-card projection with a finality-aware trust decision. Never SELECTs arbitrary profile columns.';
