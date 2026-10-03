/**
 * Short-link redirect prototype (issue #627, ADR-004).
 *
 * GET /r/<code>
 *
 * Resolves a base62 short code to a card_public_id and 302-redirects to
 * /card/<card_public_id>.  Returns 404 if the code is unknown.
 *
 * Security:
 *   • Referrer-Policy: no-referrer — prevents the redirect target (which
 *     contains the card_public_id) from leaking to the destination via the
 *     Referer header.
 *   • The short code maps only to card_public_id, never to a capability token.
 *   • The code format is validated before the DB lookup to prevent injection.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const CODE_PATTERN = /^[A-Za-z0-9]{6,16}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;

  if (!CODE_PATTERN.test(code)) {
    return new NextResponse("Not found.", { status: 404 });
  }

  const supabase = await createClient();
  const { data } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("short_links" as any)
    .select("card_public_id")
    .eq("code", code)
    .maybeSingle();

  if (!data) {
    return new NextResponse("Not found.", { status: 404 });
  }

  return NextResponse.redirect(
    new URL(`/card/${(data as { card_public_id: string }).card_public_id}`, process.env.NEXT_PUBLIC_APP_URL ?? "https://lafiya.xyz"),
    {
      status: 302,
      headers: {
        // Prevent the redirect target from appearing in the Referer header of
        // the destination page — the card_public_id must not leak to providers.
        "Referrer-Policy": "no-referrer",
        // Prevent this redirect response from being cached by CDN/browser;
        // the mapping may change when a card is regenerated.
        "Cache-Control": "no-store",
      },
    },
  );
}
