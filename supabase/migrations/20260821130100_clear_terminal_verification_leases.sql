-- A request leaving review must never retain a usable lease. This protects
-- supersession by a newer patient revision as well as manual terminal changes.

create function public.clear_terminal_verification_lease()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'under_review' then
    new.lease_token := null;
    new.lease_expires_at := null;
  end if;
  return new;
end;
$$;

create trigger reattestation_requests_clear_terminal_lease
before update of status on public.reattestation_requests
for each row execute function public.clear_terminal_verification_lease();
