import { NextResponse } from "next/server";
import { z } from "zod";

import { logError } from "@/lib/logging/logger";
import { buildCardPdf } from "@/lib/pdf/accessible-card";
import { createClient } from "@/lib/supabase/server";

/**
 * ROUTE: POST /api/card/pdf
 *
 * Renders the signed-in patient's printable card as a tagged, accessible
 * PDF (PDF/UA-1) — issue #773. The body is the same card projection the
 * profile page already shows the owner, so this route renders exactly what
 * is visible and nothing more.
 */
const list = z.array(z.string().max(200)).max(50).nullable();
const requestSchema = z.object({
  cardUrl: z.url().max(500),
  cardPin: z
    .string()
    .regex(/^[0-9]{4,10}$/)
    .optional(),
  card: z.object({
    name: z.string().max(200).nullable(),
    age: z.number().int().min(0).max(150).nullable(),
    blood_group: z.string().max(10).nullable(),
    genotype: z.string().max(10).nullable(),
    allergies: list,
    medications: list,
    chronic_conditions: list,
    emergency_contacts: z
      .array(
        z.object({
          name: z.string().max(200),
          phone: z.string().max(40),
          relationship: z.string().max(100),
        }),
      )
      .max(10)
      .nullable(),
    language: z.string().max(100).nullable(),
  }),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
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
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid card payload." },
      { status: 400 },
    );
  }

  try {
    const { card, cardUrl, cardPin } = parsed.data;
    const pdf = buildCardPdf(card, cardUrl, cardPin);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition":
          'attachment; filename="lafiya-emergency-card.pdf"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logError("Failed to generate card PDF", error, { route: "/api/card/pdf" });
    return NextResponse.json(
      { error: "Could not generate the PDF." },
      { status: 500 },
    );
  }
}
