-- Allow authenticated users to record their own consent acknowledgement
-- (used by the profile "acknowledge policy" action, issue #146).
--
-- The unique (user_id, policy_version) constraint already guarantees at most
-- one row per (user, version). This WITH CHECK policy guarantees a user can
-- ONLY insert rows where user_id matches their own auth.uid(), so a user
-- cannot record consent on behalf of another account. Read access remains
-- scoped by the existing consent_logs_select_own policy.
create policy "consent_logs_insert_own"
on public.consent_logs for insert
to authenticated
with check (auth.uid() = user_id);

grant insert on public.consent_logs to authenticated;
