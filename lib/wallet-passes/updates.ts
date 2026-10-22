import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Keeps wallet passes in sync with the card (issue #771).
 *
 * - `handlePassKitRequest` implements Apple's PassKit web service
 *   (https://developer.apple.com/documentation/walletpasses/adding_a_web_service_to_update_passes):
 *   device registration/unregistration, serial listing, latest-pass fetch and
 *   log. Mounted at `app/api/wallet/apple/v1/[...path]/route.ts`.
 * - `processCardChanged` is the outbox handler body: it bumps the pass's
 *   `updated_at`, then sends at most one push per coalescing window. A change
 *   inside the window is deferred (the outbox retries it) and the next push
 *   covers every change since the device's last fetch.
 * - `voidPasses` marks passes void and pushes once so devices fetch the
 *   voided pass, then removes registrations (account deletion).
 *
 * Serial numbers are capability digests (see `buildWalletPassContent`);
 * authentication tokens are an HMAC of the serial, so they are verified
 * without being stored.
 */

export const DEFAULT_COALESCE_WINDOW_MS = 5 * 60 * 1000;

export interface PassRecord {
  serial: string;
  updatedAt: number;
  lastPushAt: number | null;
  voided: boolean;
  /** Decrypted barcode URL (the capability is already revoked once voided). */
  capabilityUrl: string;
}

export interface PassRegistrationStore {
  /** Returns true if the registration was newly created. */
  register(device: string, pushToken: string, serial: string): Promise<boolean>;
  /** Returns true if a registration existed and was removed. */
  unregister(device: string, serial: string): Promise<boolean>;
  serialsForDevice(
    device: string,
    updatedSince: number | null,
  ): Promise<PassRecord[]>;
  getPass(serial: string): Promise<PassRecord | null>;
  pushTokens(serial: string): Promise<string[]>;
  markUpdated(
    serial: string,
    now: number,
    opts?: { voided?: boolean },
  ): Promise<void>;
  recordPush(serial: string, now: number): Promise<void>;
  removeRegistrations(serial: string): Promise<void>;
}

export interface PassPusher {
  /** Sends an empty APNs push (topic = pass type id) to each token. */
  push(pushTokens: string[]): Promise<void>;
}

export interface PassKitDeps {
  store: PassRegistrationStore;
  passTypeIdentifier: string;
  authSecret: string;
  /** Builds the signed `.pkpass` for the stored pass (voided passes carry `voided: true`). */
  renderPass(pass: PassRecord): Promise<Buffer>;
  clock?: () => number;
}

export class PassUpdateDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super("PASS_UPDATE_DEFERRED");
    this.name = "PassUpdateDeferredError";
  }
}

export function passAuthToken(serial: string, secret: string): string {
  return createHmac("sha256", secret).update(`passkit:${serial}`).digest("hex");
}

function authorized(
  header: string | null,
  serial: string,
  secret: string,
): boolean {
  const match = /^ApplePass ([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(
    Buffer.from(match[1]),
    Buffer.from(passAuthToken(serial, secret)),
  );
}

export interface PassKitRequest {
  method: string;
  /** Path segments after `/v1`, e.g. ["devices", id, "registrations", type, serial]. */
  path: string[];
  authorization: string | null;
  ifModifiedSince: string | null;
  query: URLSearchParams;
  body: unknown;
}

export interface PassKitResponse {
  status: number;
  json?: unknown;
  pkpass?: Buffer;
  lastModified?: string;
}

const SERIAL = /^[0-9a-f]{64}$/;
const DEVICE = /^[A-Za-z0-9]{1,64}$/;

export async function handlePassKitRequest(
  req: PassKitRequest,
  deps: PassKitDeps,
): Promise<PassKitResponse> {
  const [root, ...rest] = req.path;

  if (root === "log" && req.method === "POST") {
    return { status: 200 };
  }

  if (root === "devices" && rest[1] === "registrations") {
    const [device, , passType, serial] = rest;
    if (!DEVICE.test(device ?? "") || passType !== deps.passTypeIdentifier) {
      return { status: 404 };
    }

    if (rest.length === 3 && req.method === "GET") {
      const tag = req.query.get("passesUpdatedSince");
      const since = tag && /^\d+$/.test(tag) ? Number(tag) : null;
      const passes = await deps.store.serialsForDevice(device, since);
      if (passes.length === 0) return { status: 204 };
      return {
        status: 200,
        json: {
          serialNumbers: passes.map((p) => p.serial),
          lastUpdated: String(Math.max(...passes.map((p) => p.updatedAt))),
        },
      };
    }

    if (rest.length === 4 && SERIAL.test(serial ?? "")) {
      if (!authorized(req.authorization, serial, deps.authSecret))
        return { status: 401 };
      if (req.method === "POST") {
        const pushToken =
          typeof req.body === "object" && req.body !== null
            ? (req.body as { pushToken?: unknown }).pushToken
            : undefined;
        if (
          typeof pushToken !== "string" ||
          !/^[0-9a-fA-F]{16,200}$/.test(pushToken)
        ) {
          return { status: 400 };
        }
        if (!(await deps.store.getPass(serial))) return { status: 401 };
        const created = await deps.store.register(device, pushToken, serial);
        return { status: created ? 201 : 200 };
      }
      if (req.method === "DELETE") {
        await deps.store.unregister(device, serial);
        return { status: 200 };
      }
    }
    return { status: 404 };
  }

  if (root === "passes" && rest.length === 2 && req.method === "GET") {
    const [passType, serial] = rest;
    if (passType !== deps.passTypeIdentifier || !SERIAL.test(serial))
      return { status: 404 };
    if (!authorized(req.authorization, serial, deps.authSecret))
      return { status: 401 };
    const pass = await deps.store.getPass(serial);
    if (!pass) return { status: 401 };
    const updatedSec = Math.floor(pass.updatedAt / 1000);
    const since = req.ifModifiedSince ? Date.parse(req.ifModifiedSince) : NaN;
    const lastModified = new Date(updatedSec * 1000).toUTCString();
    if (!Number.isNaN(since) && Math.floor(since / 1000) >= updatedSec) {
      return { status: 304, lastModified };
    }
    return { status: 200, pkpass: await deps.renderPass(pass), lastModified };
  }

  return { status: 404 };
}

/** Decides whether a push may go out now or must wait for the window to close. */
export function nextPushAt(
  lastPushAt: number | null,
  now: number,
  windowMs: number,
): number {
  return lastPushAt === null ? now : Math.max(now, lastPushAt + windowMs);
}

export async function processCardChanged(
  serial: string,
  deps: {
    store: PassRegistrationStore;
    pusher: PassPusher;
    clock?: () => number;
    windowMs?: number;
  },
): Promise<"pushed" | "no_devices"> {
  const now = (deps.clock ?? Date.now)();
  const pass = await deps.store.getPass(serial);
  if (!pass) return "no_devices";
  if (pass.updatedAt < now) await deps.store.markUpdated(serial, now);
  const at = nextPushAt(
    pass.lastPushAt,
    now,
    deps.windowMs ?? DEFAULT_COALESCE_WINDOW_MS,
  );
  if (at > now) throw new PassUpdateDeferredError(at);
  const tokens = await deps.store.pushTokens(serial);
  if (tokens.length === 0) return "no_devices";
  await deps.pusher.push(tokens);
  await deps.store.recordPush(serial, now);
  return "pushed";
}

/** Voids each pass, pushes so devices fetch the voided version, then drops registrations. */
export async function voidPasses(
  serials: string[],
  deps: {
    store: PassRegistrationStore;
    pusher: PassPusher;
    clock?: () => number;
  },
): Promise<void> {
  const now = (deps.clock ?? Date.now)();
  for (const serial of serials) {
    await deps.store.markUpdated(serial, now, { voided: true });
    const tokens = await deps.store.pushTokens(serial);
    if (tokens.length > 0) await deps.pusher.push(tokens);
    await deps.store.removeRegistrations(serial);
  }
}
