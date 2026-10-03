/*
 * Layout for the public emergency card route.
 *
 * Why this layout exists:
 *
 * 1. FONT OVERRIDE — The root layout (app/layout.tsx) loads Geist from Google
 *    Fonts via next/font. For the emergency card the guiding constraint is
 *    "load fast on 2G/3G and be readable when printed." Loading a custom font
 *    is the single biggest optional payload on this route (~30–50 kB of WOFF2
 *    plus a blocking network round-trip). This layout resets --font-sans to a
 *    system-font stack so the page looks clean without any font download.
 *
 *    System-font rendering is indistinguishable from a custom font for a
 *    responder reading blood group / allergy information under pressure — the
 *    tradeoff is entirely in favour of speed and offline reliability.
 *
 * 2. PRINT CSS — print.css is scoped here so it doesn't add any payload to
 *    the rest of the app. Next.js CSS imports in layout/page components are
 *    bundled into the route's own CSS chunk.
 *
 * 3. LABEL LOCALE — The card is rendered bilingually: field labels follow the
 *    responder's language, negotiated from the Accept-Language header, while
 *    patient-entered free text keeps its own language (profiles.language) and
 *    is marked with a `lang` attribute. The negotiated locale is exposed on
 *    <html lang> so assistive tech and the browser pick the right language for
 *    the label text. The manual switch (a plain link, no JS required) persists
 *    the responder's choice in a cookie; when that cookie is present it wins
 *    over Accept-Language.
 */

import { cookies, headers } from "next/headers";
import "./print.css";

/**
 * Locales we ship reviewed clinical label translations for. Kept in sync with
 * the glossary used by the card content and the offline envelope.
 */
const SUPPORTED_LABEL_LOCALES = ["en", "ha", "fr", "ar"] as const;

const DEFAULT_LABEL_LOCALE = "en";

/** Cookie that persists the responder's manual label-language choice. */
const LABEL_LOCALE_COOKIE = "card_label_locale";

/**
 * Pick the best supported label locale from an Accept-Language header value.
 *
 * We deliberately do a simple, dependency-free negotiation: parse the
 * comma-separated list, honour q-values, and match on the primary subtag
 * (e.g. "ha-NG" → "ha"). This keeps the route free of extra runtime weight
 * and avoids sending anything to a third party.
 */
function negotiateLabelLocale(acceptLanguage: string | null): string {
  if (!acceptLanguage) return DEFAULT_LABEL_LOCALE;

  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.split("=")[1]) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isNaN(q) ? 0 : q };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    const match = SUPPORTED_LABEL_LOCALES.find((locale) => locale === primary);
    if (match) return match;
  }

  return DEFAULT_LABEL_LOCALE;
}

/**
 * Resolve the label locale for this request. A manual choice stored in the
 * cookie takes precedence over the Accept-Language header so the no-JS switch
 * link is sticky across visits.
 */
function resolveLabelLocale(
  cookieValue: string | undefined,
  acceptLanguage: string | null,
): string {
  if (
    cookieValue &&
    (SUPPORTED_LABEL_LOCALES as readonly string[]).includes(cookieValue)
  ) {
    return cookieValue;
  }
  return negotiateLabelLocale(acceptLanguage);
}

export default function CardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = cookies();
  const headerStore = headers();

  const labelLocale = resolveLabelLocale(
    cookieStore.get(LABEL_LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
  );

  return (
    <>
      {/*
       * Override the Geist custom-font variables set by the root layout.
       * The style tag is inlined (no extra network request) and applies before
       * any paint, so there is no flash of the wrong font.
       *
       * The stack below:
       *   - ui-sans-serif  → San Francisco (macOS/iOS), Segoe UI (Windows 11)
       *   - system-ui      → the platform default UI font (Android, Linux)
       *   - Arial          → universal fallback included in every browser
       *   - sans-serif     → ultimate fallback
       */}
      <style>{`
        :root {
          --font-sans: ui-sans-serif, system-ui, Arial, sans-serif;
          --font-mono: ui-monospace, "Courier New", monospace;
        }
      `}</style>
      {/*
       * Announce the negotiated label language to assistive tech and the
       * browser. Free-text blocks rendered by the card content carry their own
       * `lang` attribute (the patient's entry language), which overrides this
       * for those spans so screen readers switch voices correctly.
       */}
      <div lang={labelLocale} data-label-locale={labelLocale}>
        {children}
      </div>
    </>
  );
}
