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
 * 3. ZERO-CLIENT-COMPONENT POLICY — This route is intentionally a pure
 *    server-rendered page. No "use client" components may be rendered from
 *    this layout or its descendants, apart from an explicitly allowlisted set
 *    of islands (currently: none — service worker registration lives outside
 *    the card route). The policy is enforced at build time by
 *    scripts/check-client-bundles.js, which fails CI when the card route's
 *    client JS exceeds its byte budget. See CONTRIBUTING.md for details.
 */

import "./print.css";

export default function CardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
      {children}
    </>
  );
}
