import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";

import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { EmergencyCardContent } from "./card-content";

// Every live access is authorized/accounted for asynchronously. Offline use
// is served exclusively from the structured service-worker envelope, never a
// stale ISR document that could outlive a revocation or revision update.
export const dynamic = "force-dynamic";

// This page is unauthenticated and reachable by anyone with the link (that's
// the point — a responder scanning a QR shouldn't need to log in), but it
// must never be indexed or crawled.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PublicCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_emergency_card", {
    p_card_id: id,
  });

  if (error) {
    // Public card IDs are bearer-like capabilities: keep them out of logs,
    // traces, and error-reporting payloads.
    logError("Failed to load emergency card", new Error("CARD_LOOKUP_FAILED"), {
      route: "/card/[id]",
    });
    throw new Error("UNAVAILABLE");
  }

  if (!data || data.length === 0) {
    notFound();
  }

  after(async () => {
    try {
      await createAdminClient().rpc("record_legacy_card_access_event", {
        p_card_id: id,
      });
    } catch (accessEventError) {
      logError("Failed to record emergency-card access", accessEventError, {
        route: "/card/[id]",
      });
    }
  });

  // Issue #383: get_emergency_card deliberately never returns the card's
  // user_id (see the function's own comment), so ownership can't be
  // determined from `data`. Instead: if someone is signed in, look up
  // *their own* card_public_id (an ordinary read of their own row, already
  // permitted by RLS) and compare it to the route param.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let isOwner = false;
  if (user) {
    const { data: ownProfile } = await supabase
      .from("profiles")
      .select("card_public_id")
      .eq("user_id", user.id)
      .maybeSingle();
    isOwner = ownProfile?.card_public_id === id;
  }

  return (
    <EmergencyCardContent
      card={data[0]}
      authorizationKind="legacy"
      isOwner={isOwner}
    />
  );
}
