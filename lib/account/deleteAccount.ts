import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

const AVATAR_DELETE_BATCH_SIZE = 100;

/**
 * Removes account data that is not covered by database cascades, then deletes
 * the auth user that owns the remaining relational data.
 *
 * Supabase Storage objects do not cascade when an auth user is deleted.
 *
 * Emergency capability shares are revoked explicitly here, even though the
 * `emergency_capabilities` table has `ON DELETE CASCADE` on its `user_id`
 * foreign key to `auth.users`. Explicit revocation is preferred because:
 *   1. It makes the revocation intent visible and auditable in code.
 *   2. It avoids a window between storage cleanup and user deletion where a
 *      live capability could still resolve against orphaned data.
 *   3. It remains correct even if the cascade constraint is ever changed.
 *
 * The `emergency_capabilities` table has `Update: never` in its TypeScript
 * type to prevent untrusted client-side mutations, but the service-role admin
 * client bypasses RLS entirely. The cast below is intentional and safe.
 */
export async function deleteAccountAndData(
  admin: AdminClient,
  userId: string,
): Promise<void> {
  // 1. Revoke all active capability shares so no previously-shared link can
  //    resolve to the patient's data after deletion.
  //
  //    The `Update: never` type on emergency_capabilities prevents unintended
  //    mutations from client-side code. The service-role admin client used
  //    here bypasses RLS, so the cast to `unknown` is intentional and safe.
  const { error: revokeError } = await (
    admin.from("emergency_capabilities") as unknown as {
      update: (
        data: { revoked_at: string },
      ) => { eq: (col: string, val: string) => { is: (col: string, val: null) => Promise<{ error: { message: string } | null }> } };
    }
  )
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);

  if (revokeError) {
    throw new Error(
      `Failed to revoke capability shares: ${revokeError.message}`,
      { cause: revokeError },
    );
  }

  // 2. Remove avatar storage objects. Supabase Storage does not cascade on
  //    auth user deletion, so this must be explicit.
  while (true) {
    const { data: objects, error: listError } = await admin.storage
      .from("avatars")
      .list(userId, { limit: AVATAR_DELETE_BATCH_SIZE, offset: 0 });

    if (listError) {
      throw new Error(`Failed to list account avatars: ${listError.message}`, {
        cause: listError,
      });
    }

    if (!objects || objects.length === 0) {
      break;
    }

    const paths = objects.map((object) => `${userId}/${object.name}`);
    const { error: removeError } = await admin.storage
      .from("avatars")
      .remove(paths);

    if (removeError) {
      throw new Error(
        `Failed to remove account avatars: ${removeError.message}`,
        { cause: removeError },
      );
    }
  }

  // 3. Delete the auth user. The DB cascade removes the profiles row and all
  //    remaining relational data tied to this user_id.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);

  if (deleteError) {
    throw new Error(`Failed to delete account: ${deleteError.message}`, {
      cause: deleteError,
    });
  }
}
