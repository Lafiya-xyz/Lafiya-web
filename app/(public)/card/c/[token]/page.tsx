import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";

import {
  digestCapability,
  isCapabilityToken,
} from "@/lib/emergency/capability";
import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { EmergencyCardContent } from "../../[id]/card-content";
import { ExpiredCapabilityState } from "./expired-state";

// A capability's policy (expiry, revocation, and view budget) must be checked
// for every live navigation. It is intentionally never ISR/CDN cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function CapabilityCardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isCapabilityToken(token)) notFound();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("consume_emergency_capability", {
    p_token_digest: digestCapability(token),
  });

  if (error) {
    logError(
      "Failed to resolve emergency capability",
      new Error("CAPABILITY_LOOKUP_FAILED"),
      {
        route: "/card/c/[token]",
      },
    );
    throw new Error("UNAVAILABLE");
  }

  const resolution = data?.[0];

  // Malformed and unknown tokens (and a profile made unavailable through
  // consent/lifecycle changes) are indistinguishable from each other, since
  // none of those are properties of the capability itself.
  if (!resolution || resolution.access_state === "not_found") {
    notFound();
  }

  // Revoked/expired/exhausted ARE properties of the capability the holder
  // presented, so surfacing them (as one shared message, not three) tells a
  // responder to ask the patient for a new link instead of re-trying a dead
  // one. Distinguishing this from "unknown link" is not an oracle: the
  // token is a digest of 256 random bits, so guessing a real one is
  // infeasible regardless of what the response reveals.
  if (
    resolution.access_state === "revoked" ||
    resolution.access_state === "expired" ||
    resolution.access_state === "exhausted"
  ) {
    return <ExpiredCapabilityState />;
  }

  if (resolution.access_state !== "active" || !resolution.capability_id) {
    notFound();
  }

  const { capability_id: capabilityId, ...card } = resolution;
  after(async () => {
    try {
      const admin = createAdminClient();
      await admin.rpc("record_card_access_event", {
        p_capability_id: capabilityId,
        p_access_kind: "capability",
        p_outcome: "served",
      });
    } catch (accessEventError) {
      // Deferred accountability is best-effort by design. No raw capability,
      // identifier, patient data, or error payload reaches the logger.
      logError("Failed to record emergency-card access", accessEventError, {
        route: "/card/c/[token]",
      });
    }
  });

  return <EmergencyCardContent card={card} authorizationKind="capability" />;
}
