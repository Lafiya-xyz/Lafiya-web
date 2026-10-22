import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { connect } from "node:http2";

import { createAdminClient } from "@/lib/supabase/admin";
import type { OutboxHandler } from "@/lib/outbox/types";

import { generateApplePass } from "./apple";
import { getAppleWalletConfig, WalletPassesNotConfiguredError } from "./config";
import {
  processCardChanged,
  voidPasses,
  type PassKitDeps,
  type PassPusher,
  type PassRecord,
  type PassRegistrationStore,
} from "./updates";

/** Supabase + APNs wiring for lib/wallet-passes/updates.ts (issue #771). */

function authSecret(): string {
  const secret = process.env.WALLET_PASS_AUTH_SECRET;
  if (!secret)
    throw new WalletPassesNotConfiguredError("apple", [
      "WALLET_PASS_AUTH_SECRET",
    ]);
  return secret;
}

function barcodeKey(): Buffer {
  return createHash("sha256").update(`wallet-barcode:${authSecret()}`).digest();
}

function encryptBarcode(url: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", barcodeKey(), iv);
  const body = Buffer.concat([c.update(url, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function decryptBarcode(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", barcodeKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString(
    "utf8",
  );
}

interface PassRow {
  serial: string;
  barcode_ciphertext: string;
  updated_at: string;
  last_push_at: string | null;
  voided_at: string | null;
}

function toRecord(row: PassRow): PassRecord {
  return {
    serial: row.serial,
    updatedAt: Date.parse(row.updated_at),
    lastPushAt: row.last_push_at ? Date.parse(row.last_push_at) : null,
    voided: row.voided_at !== null,
    capabilityUrl: decryptBarcode(row.barcode_ciphertext),
  };
}

function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data;
}

export function supabasePassStore(): PassRegistrationStore {
  // wallet_passes tables are not yet in the generated Database types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient({ purpose: "wallet-passes" }) as any;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    async register(device, pushToken, serial) {
      const existing = check(
        await db
          .from("wallet_pass_registrations")
          .select("serial")
          .eq("device_library_id", device)
          .eq("serial", serial),
      ) as unknown[];
      check(
        await db
          .from("wallet_pass_registrations")
          .upsert({ device_library_id: device, serial, push_token: pushToken }),
      );
      return existing.length === 0;
    },
    async unregister(device, serial) {
      const rows = check(
        await db
          .from("wallet_pass_registrations")
          .delete()
          .eq("device_library_id", device)
          .eq("serial", serial)
          .select("serial"),
      ) as unknown[];
      return rows.length > 0;
    },
    async serialsForDevice(device, since) {
      let q = db
        .from("wallet_passes")
        .select("*, wallet_pass_registrations!inner(device_library_id)")
        .eq("wallet_pass_registrations.device_library_id", device);
      if (since !== null) q = q.gt("updated_at", iso(since));
      return (check(await q) as PassRow[]).map(toRecord);
    },
    async getPass(serial) {
      const row = check(
        await db
          .from("wallet_passes")
          .select("*")
          .eq("serial", serial)
          .maybeSingle(),
      ) as PassRow | null;
      return row ? toRecord(row) : null;
    },
    async pushTokens(serial) {
      const rows = check(
        await db
          .from("wallet_pass_registrations")
          .select("push_token")
          .eq("serial", serial),
      ) as { push_token: string }[];
      return rows.map((r) => r.push_token);
    },
    async markUpdated(serial, now, opts) {
      const patch: Record<string, unknown> = { updated_at: iso(now) };
      if (opts?.voided) patch.voided_at = iso(now);
      check(await db.from("wallet_passes").update(patch).eq("serial", serial));
    },
    async recordPush(serial, now) {
      check(
        await db
          .from("wallet_passes")
          .update({ last_push_at: iso(now) })
          .eq("serial", serial),
      );
    },
    async removeRegistrations(serial) {
      check(
        await db
          .from("wallet_pass_registrations")
          .delete()
          .eq("serial", serial),
      );
    },
  };
}

/** Records an issued pass so devices can later register for its updates. */
export async function recordIssuedPass(
  serial: string,
  capabilityUrl: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient({ purpose: "wallet-passes" }) as any;
  check(
    await db.from("wallet_passes").upsert({
      serial,
      barcode_ciphertext: encryptBarcode(capabilityUrl),
      voided_at: null,
    }),
  );
}

/** Pass updates are pushed over APNs with the pass type certificate. */
export function apnsPusher(): PassPusher {
  const config = getAppleWalletConfig();
  return {
    async push(tokens) {
      const session = connect("https://api.push.apple.com", {
        cert: Buffer.from(config.signerCertBase64, "base64"),
        key: Buffer.from(config.signerKeyBase64, "base64"),
        passphrase: config.signerKeyPassphrase,
      });
      try {
        await Promise.all(
          tokens.map(
            (token) =>
              new Promise<void>((resolve, reject) => {
                const req = session.request({
                  ":method": "POST",
                  ":path": `/3/device/${token}`,
                  "apns-topic": config.passTypeIdentifier,
                  "content-type": "application/json",
                });
                req.on("response", (headers) => {
                  const status = Number(headers[":status"]);
                  // 410: device token no longer valid — nothing to retry.
                  if (status === 200 || status === 410) resolve();
                  else reject(new Error(`APNS_${status}`));
                });
                req.on("error", reject);
                req.end("{}");
              }),
          ),
        );
      } finally {
        session.close();
      }
    },
  };
}

export function passKitDeps(): PassKitDeps {
  return {
    store: supabasePassStore(),
    passTypeIdentifier: getAppleWalletConfig().passTypeIdentifier,
    authSecret: authSecret(),
    renderPass: (pass) =>
      generateApplePass(pass.capabilityUrl, { voided: pass.voided }),
  };
}

/** Outbox handler for `wallet_pass:card_changed`; a deferred push throws so the row is retried. */
export const handleWalletCardChanged: OutboxHandler = async (row) => {
  const serial = row.payload["serial"];
  if (typeof serial !== "string" || !/^[0-9a-f]{64}$/.test(serial)) return;
  try {
    getAppleWalletConfig();
  } catch (err) {
    if (err instanceof WalletPassesNotConfiguredError) return;
    throw err;
  }
  await processCardChanged(serial, {
    store: supabasePassStore(),
    pusher: apnsPusher(),
  });
};

/** Voids every pass for the given capability digests (account deletion). */
export async function voidWalletPasses(serials: string[]): Promise<void> {
  if (serials.length === 0) return;
  try {
    getAppleWalletConfig();
  } catch (err) {
    if (err instanceof WalletPassesNotConfiguredError) return;
    throw err;
  }
  await voidPasses(serials, {
    store: supabasePassStore(),
    pusher: apnsPusher(),
  });
}
