import { logInfo } from "@/lib/logging/logger";

/**
 * Issue #873: coarse, privacy-safe shift-vault audit. Accepts only hourly
 * counts of vaulted cards — never card identifiers, capabilities or PHI.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    events?: unknown;
  } | null;
  const events = Array.isArray(body?.events) ? body.events.slice(0, 24) : [];
  const valid = events.filter(
    (e): e is { hour: string; count: number } =>
      typeof e?.hour === "string" &&
      !Number.isNaN(Date.parse(e.hour)) &&
      Number.isInteger(e?.count) &&
      e.count > 0 &&
      e.count <= 20,
  );
  for (const event of valid) {
    logInfo("shift_vault.vaulted", { hour: event.hour, count: event.count });
  }
  return new Response(null, { status: 204 });
}
