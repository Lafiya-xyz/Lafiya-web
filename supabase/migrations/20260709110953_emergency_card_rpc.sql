-- Public, single-row lookup of the emergency-relevant subset of a profile
-- by its unguessable card_public_id (the value encoded in the QR code).
--
-- This is a SECURITY DEFINER function rather than a permissive RLS policy
-- on public.profiles, on purpose: a base-table policy like `using (true)`
-- would be reachable via PostgREST's generic `/rest/v1/profiles?select=*`
-- with arbitrary filters/pagination, which lets a client enumerate every
-- patient's record. This function accepts only the exact card id, returns
-- an explicit column list (never SELECT *, so a future `alter table
-- profiles add column ...` can't silently leak through it), and pins
-- search_path to prevent search-path hijacking of a SECURITY DEFINER
-- function.
create function public.get_emergency_card(p_card_id uuid)
returns table (
  name text,
  age int,
  photo_url text,
  blood_group public.blood_group_enum,
  genotype public.genotype_enum,
  allergies text[],
  medications text[],
  chronic_conditions text[],
  emergency_contacts jsonb,
  language text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.name,
    case
      when p.date_of_birth is null then null
      else extract(year from age(p.date_of_birth))::int
    end as age,
    p.photo_url,
    p.blood_group,
    p.genotype,
    p.allergies,
    p.medications,
    p.chronic_conditions,
    p.emergency_contacts,
    p.language
  from public.profiles p
  where p.card_public_id = p_card_id;
$$;

comment on function public.get_emergency_card(uuid) is
  'Public, unauthenticated lookup of the emergency-relevant subset of a profile by its unguessable card_public_id. Never returns user_id or any auth.users data.';

revoke all on function public.get_emergency_card(uuid) from public;
grant execute on function public.get_emergency_card(uuid) to anon, authenticated;
