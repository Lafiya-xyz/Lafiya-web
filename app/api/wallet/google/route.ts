import { NextResponse } from "next/server";

import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";
import {
  generateGoogleWalletSaveUrl,
  WalletPassesNotConfiguredError,
} from "@/lib/wallet-passes";
import { InvalidCapabilityUrlError } from "@/lib/wallet-passes/passContent";

/**
 * ROUTE: POST /api/wallet/google
 *
 * Returns an "Add to Google Wallet" save link (a signed JWT URL, not a
 * downloadable file — see lib/wallet-passes/google.ts) for the emergency
 * card, per issue #538. Same request shape, auth requirement, and
 * capability-URL-only design as POST /api/wallet/apple — see that route's
 * doc comment for the full rationale.
 *
 * Returns 501 (not a silent fake link) when Google Wallet signing
 * credentials are unset — see docs/wallet-passes.md.
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

    const saveUrl = await generateGoogleWalletSaveUrl(capabilityUrl);

    return NextResponse.json({ saveUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof WalletPassesNotConfiguredError) {
      return NextResponse.json(
        {
          error:
            "Google Wallet passes are not yet available on this deployment: " +
            "signing credentials are not configured. See " +
            "docs/wallet-passes.md.",
        },
        { status: 501 },
      );
    }
    if (error instanceof InvalidCapabilityUrlError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logError("Failed to generate Google Wallet save link", error, {
      route: "/api/wallet/google",
    });
    return NextResponse.json(
      { error: "Could not generate the wallet save link. Please try again." },
      { status: 500 },
    );
  }
}
