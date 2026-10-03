import { NextResponse } from "next/server";

import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";
import {
  generateApplePass,
  WalletPassesNotConfiguredError,
} from "@/lib/wallet-passes";
import { InvalidCapabilityUrlError } from "@/lib/wallet-passes/passContent";

/**
 * ROUTE: POST /api/wallet/apple
 *
 * Issues a signed `.pkpass` for the emergency card, per issue #538. The
 * caller supplies the `capabilityUrl` returned by
 * `createEmergencyCapability` (app/(auth)/profile/actions.ts) — the raw
 * capability value is shown to the patient exactly once and never
 * persisted server-side, so this route cannot and does not look one up.
 *
 * Requires an authenticated session: only the signed-in patient may mint a
 * wallet pass for a capability they just issued. This does not by itself
 * prove the capabilityUrl belongs to this user (capabilities are anonymous
 * bearer tokens by design, like the QR code), so it is a coarse
 * anti-abuse/audit gate, not a scoping check — the real authorization
 * boundary is the capability token embedded in the pass, checked again on
 * every scan by /card/c/[token].
 *
 * Returns 501 (not a silent fake pass) when Apple signing credentials are
 * unset — see docs/wallet-passes.md.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON." },
        { status: 400 },
      );
    }

    const capabilityUrl =
      typeof body === "object" && body !== null && "capabilityUrl" in body
        ? (body as { capabilityUrl: unknown }).capabilityUrl
        : undefined;

    if (typeof capabilityUrl !== "string") {
      return NextResponse.json(
        { error: "capabilityUrl (string) is required." },
        { status: 400 },
      );
    }

    const pkpass = await generateApplePass(capabilityUrl);

    return new NextResponse(new Uint8Array(pkpass), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.pkpass",
        "Content-Disposition": 'attachment; filename="lafiya-emergency-card.pkpass"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof WalletPassesNotConfiguredError) {
      return NextResponse.json(
        {
          error:
            "Apple Wallet passes are not yet available on this deployment: " +
            "signing credentials are not configured. See " +
            "docs/wallet-passes.md.",
        },
        { status: 501 },
      );
    }
    if (error instanceof InvalidCapabilityUrlError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logError("Failed to generate Apple Wallet pass", error, {
      route: "/api/wallet/apple",
    });
    return NextResponse.json(
      { error: "Could not generate the wallet pass. Please try again." },
      { status: 500 },
    );
  }
}
