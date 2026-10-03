import type {
  SessionBrowserFamily,
  SessionOsFamily,
} from "@/lib/supabase/types";

export interface CoarseUserAgent {
  browser: SessionBrowserFamily;
  os: SessionOsFamily;
}

// Order matters: many browsers embed "Chrome" and "Safari" in their UA, so
// the more specific families are matched first.
const BROWSERS: ReadonlyArray<[RegExp, SessionBrowserFamily]> = [
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\/|Chromium\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const OPERATING_SYSTEMS: ReadonlyArray<[RegExp, SessionOsFamily]> = [
  [/CrOS/, "ChromeOS"],
  [/Android/, "Android"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

/**
 * Reduces a user-agent header to a browser family and an OS family (#523).
 * Versions, device models, and every other UA detail are discarded on
 * purpose: the sessions panel only needs "Chrome on Android" to be
 * recognizable, and a full UA string is a fingerprinting signal.
 */
export function coarseUserAgent(userAgent: string | null): CoarseUserAgent {
  const ua = userAgent ?? "";
  const browser =
    BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? "Other";
  const os =
    OPERATING_SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? "Other";
  return { browser, os };
}
