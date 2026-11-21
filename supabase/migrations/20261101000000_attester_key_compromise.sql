-- Issue #897: respond to attester key compromise.
--
-- An operator marks an attester's key as compromised from a given ledger.
-- The change is two-person: one operator proposes, a different operator
-- approves. On approval, in one transaction:
--   * attestations at or after the compromise ledger become `under_review`
--     (attestations before it stay `verified`),
--   * affected patients get a notification outbox row,
--   * a re-verification request is queued per affected patient,
--   * unpaid (pending) payout obligations for affected attestations are held.
-- Protocol metadata only: no PHI is copied into any of these tables.

create table public.attester_key_compromises (
  id uuid primary key default gen_random_uuid(),
  attester_address text not null check (attester_address ~ '^G[A-Z2-7]{55}$'),
  compromised_from_ledger bigint not null check (compromised_from_ledger > 0),
  reason_code text not null check (length(reason_code) between 1 and 64),
  status text not null default 'proposed' check (
    status in ('proposed', 'approved', 'rejected')
  ),
  proposed_by text not null,
  proposed_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  affected_attestations integer,
  affected_payouts integer,
  constraint attester_key_compromises_two_person check (
    approved_by is null or approved_by <> proposed_by
  ),
  constraint attester_key_compromises_approval_pair check (
    (status = 'approved') = (approved_by is not null and approved_at is not null)
  )
);
create unique index attester_key_compromises_one_open
  on public.attester_key_compromises(attester_address)
  where status = 'proposed';
create index attester_key_compromises_address_idx
  on public.attester_key_compromises(attester_address, compromised_from_ledger desc);

alter table public.attester_key_compromises enable row level security;
revoke all on public.attester_key_compromises from anon, authenticated;
grant select, insert, update on public.attester_key_compromises to service_role;

-- Notification outbox for patients whose attestation is under review.
create table public.attestation_review_notifications (
  id uuid primary key default gen_random_uuid(),
  compromise_id uuid not null references public.attester_key_compromises(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  evidence_id uuid not null references public.attestation_evidence(id) on delete restrict,
  template text not null default 'attestation.under_review' check (
    template = 'attestation.under_review'
  ),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (compromise_id, evidence_id)
);
create index attestation_review_notifications_unsent_idx
  on public.attestation_review_notifications(created_at) where sent_at is null;

alter table public.attestation_review_notifications enable row level security;
revoke all on public.attestation_review_notifications from anon, authenticated;
grant select, insert, update on public.attestation_review_notifications to service_role;

-- Operator workflow: propose a compromise (step 1 of two-person approval).
create function public.propose_attester_key_compromise(
  p_attester_address text,
  p_compromised_from_ledger bigint,
  p_reason_code text,
  p_operator_id text
) returns public.attester_key_compromises
language plpgsql security definer set search_path = '' as $$
declare v_row public.attester_key_compromises;
begin
  if p_operator_id is null or length(p_operator_id) = 0 then
    raise exception using errcode = '42501', message = 'OPERATOR_REQUIRED';
  end if;
  if p_attester_address !~ '^G[A-Z2-7]{55}$' then
    raise exception using errcode = '22023', message = 'INVALID_ATTESTER_ADDRESS';
  end if;
  if p_compromised_from_ledger is null or p_compromised_from_ledger <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_COMPROMISE_LEDGER';
  end if;
  insert into public.attester_key_compromises(
    attester_address, compromised_from_ledger, reason_code, proposed_by)
  values (p_attester_address, p_compromised_from_ledger, p_reason_code, p_operator_id)
  returning * into v_row;
  return v_row;
end;
$$;

-- Operator workflow: approve a proposal (step 2 of two-person approval) and
-- apply the consequences atomically.
create function public.approve_attester_key_compromise(
  p_compromise_id uuid,
  p_operator_id text
) returns public.attester_key_compromises
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.attester_key_compromises;
  v_attestations integer := 0;
  v_payouts integer := 0;
begin
  if p_operator_id is null or length(p_operator_id) = 0 then
    raise exception using errcode = '42501', message = 'OPERATOR_REQUIRED';
  end if;
  select * into v_row from public.attester_key_compromises
    where id = p_compromise_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COMPROMISE_NOT_FOUND';
  end if;
  if v_row.status <> 'proposed' then
    raise exception using errcode = '23514', message = 'COMPROMISE_NOT_PROPOSED';
  end if;
  if v_row.proposed_by = p_operator_id then
    raise exception using errcode = '42501', message = 'TWO_PERSON_APPROVAL_REQUIRED';
  end if;

  -- Attestations made at or after the compromise ledger are re-classified.
  -- Earlier attestations are untouched and stay verified.
  with affected as (
    update public.trust_decisions td
      set state = 'under_review',
          reason_code = 'ATTESTER_KEY_COMPROMISED',
          updated_at = now()
      from public.attestation_evidence ae,
           public.verification_intents vi,
           public.chw_address_bindings cb
      where ae.id = td.evidence_id
        and vi.id = ae.intent_id
        and cb.id = vi.address_binding_id
        and cb.stellar_address = v_row.attester_address
        and ae.ledger_sequence >= v_row.compromised_from_ledger
        and ae.invalidated_at is null
        and td.state <> 'under_review'
      returning td.revision_id, ae.id as evidence_id, vi.chw_id
  )
  select count(*) into v_attestations from affected;

  -- Notify affected patients (one row per affected attestation).
  insert into public.attestation_review_notifications(compromise_id, user_id, evidence_id)
  select v_row.id, rr.user_id, ae.id
    from public.attestation_evidence ae
    join public.verification_intents vi on vi.id = ae.intent_id
    join public.chw_address_bindings cb on cb.id = vi.address_binding_id
    join public.reattestation_requests rrq on rrq.id = vi.request_id
    join public.record_revisions rr on rr.id = vi.revision_id
   where cb.stellar_address = v_row.attester_address
     and ae.ledger_sequence >= v_row.compromised_from_ledger
     and ae.invalidated_at is null
  on conflict (compromise_id, evidence_id) do nothing;

  -- Queue re-verification for each affected patient's current revision.
  insert into public.reattestation_requests(user_id, revision_id, status, requested_at)
  select distinct rr.user_id, rr.id, 'pending', now()
    from public.attestation_evidence ae
    join public.verification_intents vi on vi.id = ae.intent_id
    join public.chw_address_bindings cb on cb.id = vi.address_binding_id
    join public.record_revisions rr on rr.id = vi.revision_id
    join public.profiles p on p.user_id = rr.user_id and p.current_revision_id = rr.id
   where cb.stellar_address = v_row.attester_address
     and ae.ledger_sequence >= v_row.compromised_from_ledger
     and ae.invalidated_at is null
     and not exists (
       select 1 from public.reattestation_requests r
        where r.revision_id = rr.id and r.status in ('pending', 'leased')
     );

  -- Hold unpaid payouts for the affected attestations.
  with held as (
    update public.payout_obligations po
      set status = 'quarantined',
          adjustment_reason = 'ATTESTER_KEY_COMPROMISED',
          adjusted_at = now()
      from public.attestation_evidence ae,
           public.verification_intents vi,
           public.chw_address_bindings cb
      where po.evidence_id = ae.id
        and vi.id = ae.intent_id
        and cb.id = vi.address_binding_id
        and cb.stellar_address = v_row.attester_address
        and ae.ledger_sequence >= v_row.compromised_from_ledger
        and po.status = 'pending'
      returning po.id
  )
  select count(*) into v_payouts from held;

  update public.attester_key_compromises
    set status = 'approved',
        approved_by = p_operator_id,
        approved_at = now(),
        affected_attestations = v_attestations,
        affected_payouts = v_payouts
    where id = v_row.id
    returning * into v_row;
  return v_row;
end;
$$;

-- Operator workflow: reject a proposal (no consequences applied).
create function public.reject_attester_key_compromise(
  p_compromise_id uuid,
  p_operator_id text
) returns public.attester_key_compromises
language plpgsql security definer set search_path = '' as $$
declare v_row public.attester_key_compromises;
begin
  if p_operator_id is null or length(p_operator_id) = 0 then
    raise exception using errcode = '42501', message = 'OPERATOR_REQUIRED';
  end if;
  select * into v_row from public.attester_key_compromises
    where id = p_compromise_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COMPROMISE_NOT_FOUND';
  end if;
  if v_row.status <> 'proposed' then
    raise exception using errcode = '23514', message = 'COMPROMISE_NOT_PROPOSED';
  end if;
  if v_row.proposed_by = p_operator_id then
    raise exception using errcode = '42501', message = 'TWO_PERSON_APPROVAL_REQUIRED';
  end if;
  update public.attester_key_compromises
    set status = 'rejected', rejected_by = p_operator_id, rejected_at = now()
    where id = v_row.id
    returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.propose_attester_key_compromise(text, bigint, text, text),
  public.approve_attester_key_compromise(uuid, text),
  public.reject_attester_key_compromise(uuid, text) from public, anon, authenticated;
grant execute on function public.propose_attester_key_compromise(text, bigint, text, text),
  public.approve_attester_key_compromise(uuid, text),
  public.reject_attester_key_compromise(uuid, text) to service_role;
