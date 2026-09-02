-- Keep the record journal private while allowing the authenticated owner-only
-- RLS policy from the governed lifecycle migration to take effect.
--
-- 20260827000001 intentionally revoked all table privileges from both anon and
-- authenticated. That made the authenticated RLS policy unreachable, and
-- owner reads returned a permission error rather than their own revisions.
grant select on table public.record_revisions to authenticated;
