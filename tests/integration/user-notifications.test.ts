import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

// Issue #764: notification inbox RLS isolation and idempotency.
describe("user_notifications", () => {
  let alice: TestUser;
  let bob: TestUser;
  let aliceNotificationId: string;

  beforeAll(async () => {
    alice = await createTestUser();
    bob = await createTestUser();
    const { data, error } = await (adminClient as any)
      .from("user_notifications")
      .insert({
        user_id: alice.id,
        event_key: `test-${alice.id}`,
        type: "new_sign_in",
        body_key: "notifications.new_sign_in",
      })
      .select("id")
      .single();
    if (error) throw error;
    aliceNotificationId = data.id;
  });

  afterAll(async () => {
    await deleteTestUser(alice.id);
    await deleteTestUser(bob.id);
  });

  it("owner can read and mark their notification read", async () => {
    const { data } = await (alice.client as any)
      .from("user_notifications")
      .select("id");
    expect(data.map((r: { id: string }) => r.id)).toContain(
      aliceNotificationId,
    );

    const { error } = await (alice.client as any)
      .from("user_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", aliceNotificationId);
    expect(error).toBeNull();
  });

  it("another user cannot read or update the notification", async () => {
    const { data } = await (bob.client as any)
      .from("user_notifications")
      .select("id")
      .eq("id", aliceNotificationId);
    expect(data).toEqual([]);

    const { data: updated } = await (bob.client as any)
      .from("user_notifications")
      .update({ read_at: null })
      .eq("id", aliceNotificationId)
      .select("id");
    expect(updated ?? []).toEqual([]);
  });

  it("record_user_notification is idempotent per event key", async () => {
    const { data: profile, error } = await (adminClient as any)
      .from("profiles")
      .upsert({ user_id: alice.id, name: "Alice" })
      .select("card_public_id")
      .single();
    if (error) throw error;

    const args = {
      p_card_public_id: profile.card_public_id,
      p_type: "mfa_change",
      p_body_key: "notifications.mfa_change",
      p_event_key: `retry-${alice.id}`,
    };
    const first = await (adminClient as any).rpc(
      "record_user_notification",
      args,
    );
    const second = await (adminClient as any).rpc(
      "record_user_notification",
      args,
    );
    expect(first.data).toBe(true);
    expect(second.data).toBe(false);

    const { count } = await (adminClient as any)
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("event_key", args.p_event_key);
    expect(count).toBe(1);
  });
});
