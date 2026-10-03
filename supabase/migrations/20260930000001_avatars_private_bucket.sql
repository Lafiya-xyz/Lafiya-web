-- Issue #528: Make avatars bucket private and update storage policies.
-- Direct public URL access is replaced with short-lived signed URLs issued
-- server-side via getAvatarSignedUrl() (lib/storage/avatar.ts).
-- Signed URLs expire in 300 seconds (5 minutes), limiting exposure after
-- card link rotation or revocation.

-- Drop the old INSERT/UPDATE/DELETE/SELECT policies that relied on the
-- public bucket model (they will be recreated below with the same RLS logic
-- but now the bucket itself is private so anonymous public reads are gone).
drop policy if exists "avatar_insert_own" on storage.objects;
drop policy if exists "avatar_update_own" on storage.objects;
drop policy if exists "avatar_delete_own" on storage.objects;
drop policy if exists "avatar_select_own" on storage.objects;

-- Make the bucket private. Any existing object paths remain unchanged;
-- only the public-read flag is revoked.
update storage.buckets
set public = false
where id = 'avatars';

-- Re-create the owner policies (unchanged logic).
create policy "avatar_insert_own"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "avatar_update_own"
on storage.objects for update
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "avatar_delete_own"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- SELECT is still required for upsert to work (see original migration comment).
-- Also allows authenticated service-role calls made by getAvatarSignedUrl().
create policy "avatar_select_own"
on storage.objects for select
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);
