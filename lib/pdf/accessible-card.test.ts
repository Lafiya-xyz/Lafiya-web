import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  buildCardPdf,
  CARD_PDF_MAX_BYTES,
  CARD_PDF_TITLE,
  cardBlocks,
  type PrintableCard,
} from "./accessible-card";
import { checkPdfUa, readingOrder } from "./pdfua-check";

const card: PrintableCard = {
  name: "Adaeze Okafor",
  age: 34,
  blood_group: "O+",
  genotype: "AS",
  allergies: ["Penicillin", "Peanuts"],
  medications: ["Metformin 500mg"],
  chronic_conditions: ["Type 2 diabetes"],
  emergency_contacts: [
    { name: "Chidi Okafor", phone: "+2348000000000", relationship: "Brother" },
  ],
  language: "Igbo",
};
const url = "https://lafiya.xyz/card/abc123";

describe("accessible card PDF", () => {
  const pdf = buildCardPdf(card, url, "123456");

  it("passes the automated PDF/UA checker", () => {
    expect(checkPdfUa(pdf)).toEqual([]);
  });

  it("stays under the low-bandwidth size budget", () => {
    expect(pdf.length).toBeLessThan(CARD_PDF_MAX_BYTES);
  });

  it("puts critical fields first in reading order", () => {
    const labels = cardBlocks(card, url)
      .filter((b) => b.tag === "H2")
      .map((b) => ("text" in b ? b.text : ""));
    expect(labels.slice(0, 3)).toEqual([
      "Allergies",
      "Current medications",
      "Chronic conditions / implants",
    ]);
    const order = readingOrder(pdf);
    expect(order[0]).toBe("H1");
    expect(order).toContain("Figure");
  });

  it("keeps the patient name out of document metadata", () => {
    const src = pdf.toString("latin1");
    const info = /\/Title \(([^)]*)\)/.exec(src)?.[1];
    expect(info).toBe(CARD_PDF_TITLE);
    expect(src).not.toContain("Adaeze");
  });

  it("only writes fields that are visible on the card", () => {
    const text = [...pdf.toString("latin1").matchAll(/stream\n/g)]
      .map((m) => {
        try {
          return inflateSync(pdf.subarray(m.index! + 7)).toString("latin1");
        } catch {
          return "";
        }
      })
      .join("");
    expect(text).toContain("(Penicillin, Peanuts) Tj");
    expect(text).toContain("(Adaeze Okafor - 34 years old) Tj");
  });

  it("fails the checker when a figure loses its alt text", () => {
    const broken = Buffer.from(
      pdf.toString("latin1").replace(/ \/Alt \([^)]*\)/, ""),
      "latin1",
    );
    expect(checkPdfUa(broken)).toContain("Figure: missing /Alt");
  });
});
