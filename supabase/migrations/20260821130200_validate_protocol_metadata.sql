-- Durable protocol metadata is deliberately allowlisted, not merely advised
-- to be non-PHI. Unknown fields are rejected before persistence.

create function public.validate_verification_submission_metadata()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(new.intent_payload) <> 'object'
    or new.intent_payload - array[
      'requestId', 'revisionId', 'recordHash', 'schemaVersion',
      'networkPassphraseHash', 'contractId', 'chwId', 'stellarAddress', 'expiresAt'
    ] <> '{}'::jsonb then
    raise exception using errcode='22023',message='INTENT_CONTAINS_UNSUPPORTED_FIELDS';
  end if;
  return new;
end;
$$;

create trigger verification_submissions_validate_metadata
before insert or update of intent_payload on public.verification_submissions
for each row execute function public.validate_verification_submission_metadata();

create function public.validate_verification_trust_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(new.evidence) <> 'object'
    or new.evidence - array[
      'source', 'provider', 'reason_code', 'contract_version', 'reorged_from',
      'observed_cursor', 'provider_count'
    ] <> '{}'::jsonb then
    raise exception using errcode='22023',message='TRUST_EVIDENCE_CONTAINS_UNSUPPORTED_FIELDS';
  end if;
  return new;
end;
$$;

create trigger verification_trust_events_validate_evidence
before insert on public.verification_trust_events
for each row execute function public.validate_verification_trust_evidence();

alter table public.chw_authorization_events
  add constraint chw_authorization_events_metadata_allowlist check (
    jsonb_typeof(metadata) = 'object' and metadata - array[
      'ticket', 'operator_note_ref', 'request_id', 'old_address', 'new_address'
    ] = '{}'::jsonb
  );

alter table public.payout_obligations
  add constraint payout_obligations_reason_code_only check (
    manual_review_reason is null or manual_review_reason ~ '^[A-Z0-9_:-]{1,80}$'
  );
