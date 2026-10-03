import { describe, expect, it } from "vitest";

import {
  createSessionTouchThrottle,
  SESSION_TOUCH_INTERVAL_MS,
  sessionIdFromAccessToken,
} from "./throttle";
import { coarseUserAgent } from "./user-agent";

describe("createSessionTouchThrottle (#523 write throttling)", () => {
  function clock() {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it("allows at most one touch per session per five minutes", () => {
    const time = clock();
    const throttle = createSessionTouchThrottle({ now: time.now });

    let writes = 0;
    // 600 requests spread evenly over 15 minutes from one session.
    for (let i = 0; i < 600; i++) {
      if (throttle.shouldTouch("session-a")) writes++;
      time.advance(1500);
    }

    expect(SESSION_TOUCH_INTERVAL_MS).toBe(300_000);
    expect(writes).toBe(3);
  });

  it("throttles each session independently", () => {
    const time = clock();
    const throttle = createSessionTouchThrottle({ now: time.now });

    expect(throttle.shouldTouch("a")).toBe(true);
    expect(throttle.shouldTouch("b")).toBe(true);
    expect(throttle.shouldTouch("a")).toBe(false);
    expect(throttle.shouldTouch("b")).toBe(false);

    time.advance(SESSION_TOUCH_INTERVAL_MS - 1);
    expect(throttle.shouldTouch("a")).toBe(false);
    time.advance(1);
    expect(throttle.shouldTouch("a")).toBe(true);
  });

  it("stays bounded by evicting the least recently touched session", () => {
    const time = clock();
    const throttle = createSessionTouchThrottle({
      now: time.now,
      maxEntries: 2,
    });

    throttle.shouldTouch("a");
    throttle.shouldTouch("b");
    throttle.shouldTouch("c"); // evicts "a"

    expect(throttle.shouldTouch("b")).toBe(false);
    expect(throttle.shouldTouch("a")).toBe(true);
  });
});

describe("sessionIdFromAccessToken", () => {
  const token = (claims: object) =>
    `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  it("reads the session_id claim", () => {
    expect(sessionIdFromAccessToken(token({ session_id: "abc" }))).toBe("abc");
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["not-a-jwt"],
    ["a.!!!.c"],
    [token({ sub: "user" })],
    [token({ session_id: 42 })],
  ])("returns null for %j", (value) => {
    expect(sessionIdFromAccessToken(value as string | null)).toBeNull();
  });
});

describe("coarseUserAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
      "Samsung Internet",
      "Android",
    ],
    [
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Chrome",
      "Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "Safari",
      "iOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
      "Chrome",
      "iOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      "Edge",
      "Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
      "Firefox",
      "macOS",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0",
      "Opera",
      "Linux",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 15699.85.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Chrome",
      "ChromeOS",
    ],
    ["curl/8.5.0", "Other", "Other"],
    [null, "Other", "Other"],
  ])("reduces %j to a family", (ua, browser, os) => {
    expect(coarseUserAgent(ua)).toEqual({ browser, os });
  });

  it("never returns version numbers or device models", () => {
    const result = coarseUserAgent(
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
    );
    expect(JSON.stringify(result)).not.toMatch(/\d|SM-S918B/);
  });
});
