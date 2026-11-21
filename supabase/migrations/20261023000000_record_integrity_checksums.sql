-- Issue #890: detect silent data corruption with keyed row checksums and a
-- periodic integrity scan.
--
-- Every committed revision gets a keyed HMAC-SHA256 over the canonical
-- clinical record (the same canonicalization the on-chain commitment uses,
-- see lib/records/canonicalization.ts), keyed by the patient's existing
-- profile_secrets pepper. The checksum is computed inside
-- save_record_revision(), so it is written in the same transaction as the
-- revision and can never be forgotten by an application code path.
--
-- The scan recomputes the checksum from the stored emergency_data and
-- compares. A mismatch means the row was modified outside the governed
-- write path (manual SQL, replication drift, storage corruption): the card
-- is quarantined and an alert row is written. Alerts carry opaque
-- identifiers only -- never clinical values.

alter table public.record_revisions
  add column integrity_checksum text
    check (integrity_checksum is null or integrity_checksum ~ '^[0-9a-f]{64}$');

comment on column public.record_revisions.integrity_checksum is
  'Issue #890: HMAC-SHA256 (key = profile_secrets.secret) over the canonical '
  'clinical record of this revision. Written only by save_record_revision(). '
  'A mismatch on recompute means the row was altered outside the governed '

-- ──────────────────────────────────────────────────────────────────────────
-- Canonicalization + checksum helpers (mirror lib/records/canonicalization.ts)
-- ──────────────────────────────────────────────────────────────────────────

-- Normalizes one text value the same way normalizeText() does: NFC, trim,
-- collapse internal whitespace runs to a single space.
create or replace function public.integrity_normalize_text(p_value text)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(normalize(coalesce(p_value, ''), NFC), '\s+', ' ', 'g')), '');
$$;
revoke all on function public.integrity_normalize_text(text) from public;

-- Normalizes a list the same way normalizeList() does: normalize each entry,
-- drop empties, de-duplicate, sort with the C collation (byte order).
create or replace function public.integrity_normalize_list(p_values jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(v order by v collate "C"), '[]'::jsonb)
  from (
    select distinct public.integrity_normalize_text(e) as v
    from jsonb_array_elements_text(coalesce(p_values, '[]'::jsonb)) as e
  ) s
  where v is not null;
$$;
revoke all on function public.integrity_normalize_list(jsonb) from public;

-- Canonical JSON of the clinical record. Field order and key names match
-- canonicalizeEmergencyRecord() exactly; presentation-only fields
-- (date_of_birth, photo_url) and disclosure choices are excluded.
create or replace function public.canonicalize_record_integrity(p_data jsonb)
returns text language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'name', public.integrity_normalize_text(p_data->>'name'),
    'bloodGroup', p_data->>'blood_group',
    'genotype', p_data->>'genotype',
    'allergies', public.integrity_normalize_list(p_data->'allergies'),
    'medications', public.integrity_normalize_list(p_data->'medications'),
    'chronicConditions', public.integrity_normalize_list(p_data->'chronic_conditions'),
    'emergencyContacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', public.integrity_normalize_text(c->>'name'),
               'phone', public.integrity_normalize_text(c->>'phone'),
               'relationship', public.integrity_normalize_text(c->>'relationship')
             ) order by
               public.integrity_normalize_text(c->>'name') collate "C",
               public.integrity_normalize_text(c->>'phone') collate "C",
               public.integrity_normalize_text(c->>'relationship') collate "C")
      from jsonb_array_elements(coalesce(p_data->'emergency_contacts', '[]'::jsonb)) as c
    ), '[]'::jsonb),
    'language', public.integrity_normalize_text(p_data->>'language')
  )::text;
$$;
revoke all on function public.canonicalize_record_integrity(jsonb) from public;

-- Keyed checksum over the canonical record. Returns null when the patient
-- has no pepper yet (the revision is then simply not covered by the scan).
create or replace function public.compute_record_integrity_checksum(
  p_user_id uuid,
  p_data jsonb
) returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_secret text;
begin
  select secret into v_secret from public.profile_secrets where user_id = p_user_id;
  if v_secret is null or v_secret !~ '^[0-9a-fA-F]{64}$' then
    return null;
  end if;
  return encode(
    extensions.hmac(public.canonicalize_record_integrity(p_data), decode(v_secret, 'hex'), 'sha256'),
    'hex'
  );
end;
$$;
revoke all on function public.compute_record_integrity_checksum(uuid, jsonb) from public;
grant execute on function public.compute_record_integrity_checksum(uuid, jsonb) to service_role;
