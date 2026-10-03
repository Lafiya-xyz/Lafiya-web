import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { ServiceWorkerRegister } from "./offline-register";
import { ThemeToggle } from "@/components/theme-toggle";

// Nigerian-language glyph coverage (Hausa, Yoruba, Igbo):
// ɓ ɗ ƙ ƴ (Latin Extended-B), ẹ ọ ṣ (Latin Extended Additional),
// and tonal diacritics such as à á ì í (Latin-1 Supplement).
// Geist ships latin + latin-ext subsets; latin-ext carries the
// extended/additional ranges needed for these characters, so we
// request both and let next/font emit the matching unicode-range
// @font-face rules. adjustFontFallback keeps the fallback metrics
// aligned to reduce CLS on the card.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  adjustFontFallback: true,
  fallback: ["system-ui", "arial", "sans-serif"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  adjustFontFallback: true,
  fallback: ["ui-monospace", "monospace"],
});

export const metadata: Metadata = {
  title: "Lafiya — Your vitals, verified",
  description:
    "A patient-owned emergency health card on Stellar. Your vitals, verified. When you can't speak, Lafiya does.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Lafiya",
  },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('lafiya-theme') || 'system';
                  var effective = theme === 'system'
                    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                    : theme;
                  document.documentElement.classList.add(effective);
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
