-- Allow authenticated patients to acknowledge a policy version for their own
-- account. The unique (user_id, policy_version) constraint keeps retries
-- idempotent, while WITH CHECK prevents cross-user inserts.
create policy "consent_logs_insert_own"
on public.consent_logs for insert
to authenticated
with check (auth.uid() = user_id);

grant insert on public.consent_logs to authenticated;
