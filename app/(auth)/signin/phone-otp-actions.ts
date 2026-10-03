"use server";

/**
 * Issue #530: Phone-number OTP sign-in server actions.
 *
 * Two-step flow:
 *   1. sendPhoneOtp    — validates the E.164 number, enforces per-number and
 *                        per-IP throttles, sends the OTP via Supabase phone auth.
 *   2. verifyPhoneOtp  — verifies the 6-digit OTP, records failure for a
 *                        separate rate-limit key, redirects to /profile on success.
 *
 * Abuse controls (Issue #530 requirement):
 *   - Per-E.164-number: max 5 OTP sends per 10 minutes (SMS pumping defence).
 *   - Per-/24 IP block: max 20 OTP sends per 10 minutes (burst from one network).
 *   - Per-number-prefix (first 7 digits): max 30 OTP sends per hour (premium
 *     prefix fraud detection — a single campaign tends to target one prefix block).
 *   - All throttles use lib/frequency-limit.ts (same Postgres-backed, cross-process
 *     counter used by photo uploads).
 *
 * Region allowlist:
 *   - Numbers are parsed with libphonenumber-js and validated against the
 *     PHONE_OTP_ALLOWED_REGIONS env var (defaults to "NG").
 *   - Numbers that don't parse, are invalid, or come from a disallowed region
 *     return the same generic error to avoid being a country-code oracle.
 *
 * Numbers are stored in E.164 format by Supabase auth — never formatted or
 * localised before being passed to the Supabase client.
 *
 * Feature flag: this file does nothing if NEXT_PUBLIC_PHONE_OTP_ENABLED is
 * not "true"; the pages check the flag before rendering the UI.
 */

import { redirect } from "next/navigation";
import { parsePhoneNumber, isValidPhoneNumber } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";

import { checkAndIncrementFrequency } from "@/lib/frequency-limit";
import { getClientIp } from "@/lib/rate-limit";
import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";

// --- Throttle constants ---

/** Max OTP sends per E.164 number per 10 min (SMS pumping defence). */
const PER_NUMBER_MAX = 5;
const PER_NUMBER_WINDOW_S = 600;

/** Max OTP sends per /24 IP block per 10 min. */
const PER_IP24_MAX = 20;
const PER_IP24_WINDOW_S = 600;

/** Max sends per 7-digit prefix per hour (toll-fraud prefix detection). */
const PER_PREFIX_MAX = 30;
const PER_PREFIX_WINDOW_S = 3600;

/** Max OTP verify attempts per number per 10 min. */
const VERIFY_MAX = 10;
const VERIFY_WINDOW_S = 600;

// --- Allowed regions ---

function getAllowedRegions(): CountryCode[] {
  const raw = process.env.PHONE_OTP_ALLOWED_REGIONS ?? "NG";
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase() as CountryCode)
    .filter(Boolean);
}

/**
 * Normalise and validate a phone number string.
 * Returns the E.164 form if valid + in an allowed region, else null.
 * Uses NG as the default region hint so users can enter local formats
 * (e.g. 0801xxxxxxx) without a country prefix.
 */
function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const allowed = getAllowedRegions();
  const defaultHint: CountryCode = allowed[0] ?? "NG";
  try {
    const parsed = parsePhoneNumber(trimmed, defaultHint);
    if (!parsed || !parsed.isValid()) return null;
    if (!isValidPhoneNumber(trimmed, defaultHint) && !isValidPhoneNumber(trimmed)) {
      return null;
    }
    const region = parsed.country as CountryCode | undefined;
    if (region && !allowed.includes(region)) return null;
    return parsed.format("E.164");
  } catch {
    return null;
  }
}

/** Derive /24 IP block key from a raw IP string. */
function ip24Block(ip: string): string {
  // IPv4: take first 3 octets.  IPv6: take first 48 bits (first 3 groups).
  const parts = ip.split(".");
  if (parts.length === 4) return parts.slice(0, 3).join(".");
  // IPv6
  const groups = ip.split(":");
  return groups.slice(0, 3).join(":");
}

// ---- State types ----

export type SendOtpState = {
  error?: string;
  /** Set when OTP was dispatched — switches UI to code-entry step. */
  sent?: boolean;
  /** E.164 phone that was used (needed to submit the verify step). */
  e164?: string;
};

export type VerifyOtpState = {
  error?: string;
};

// ---- Actions ----

export async function sendPhoneOtp(
  _prev: SendOtpState | undefined,
  formData: FormData,
): Promise<SendOtpState> {
  const rawPhone = formData.get("phone");
  if (typeof rawPhone !== "string") {
    return { error: "Enter a phone number." };
  }

  const e164 = normalisePhone(rawPhone);
  if (!e164) {
    return {
      error:
        "Enter a valid Nigerian phone number (e.g. +2348001234567 or 08001234567).",
    };
  }

  const ip = await getClientIp();
  const prefix = e164.slice(0, 7); // e.g. +234801
  const ipBlock = ip24Block(ip);

  // Enforce all three throttles in parallel.
  const [perNumber, perIp, perPrefix] = await Promise.all([
    checkAndIncrementFrequency(
      `phone-otp-send:${e164}`,
      PER_NUMBER_MAX,
      PER_NUMBER_WINDOW_S,
    ),
    checkAndIncrementFrequency(
      `phone-otp-ip24:${ipBlock}`,
      PER_IP24_MAX,
      PER_IP24_WINDOW_S,
    ),
    checkAndIncrementFrequency(
      `phone-otp-prefix:${prefix}`,
      PER_PREFIX_MAX,
      PER_PREFIX_WINDOW_S,
    ),
  ]);

  const blocked = [perNumber, perIp, perPrefix].find((r) => !r.allowed);
  if (blocked) {
    return {
      error: `Too many requests. Please try again in ${blocked.retryAfterSeconds} seconds.`,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    phone: e164,
  });

  if (error) {
    logError("Failed to send phone OTP", error, {
      route: "/signin (phone-otp sendPhoneOtp)",
    });
    return { error: "Could not send the code. Please try again." };
  }

  return { sent: true, e164 };
}

export async function verifyPhoneOtp(
  _prev: VerifyOtpState | undefined,
  formData: FormData,
): Promise<VerifyOtpState> {
  const e164 = formData.get("e164");
  const token = formData.get("token");

  if (typeof e164 !== "string" || !e164) {
    return { error: "Session expired. Please start over." };
  }
  if (typeof token !== "string" || !/^\d{6}$/.test(token.trim())) {
    return { error: "Enter the 6-digit code from your SMS." };
  }

  // Rate-limit OTP attempts to mitigate online guessing.
  const freq = await checkAndIncrementFrequency(
    `phone-otp-verify:${e164}`,
    VERIFY_MAX,
    VERIFY_WINDOW_S,
  );
  if (!freq.allowed) {
    return {
      error: `Too many attempts. Please try again in ${freq.retryAfterSeconds} seconds.`,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    phone: e164,
    token: token.trim(),
    type: "sms",
  });

  if (error) {
    return { error: "Incorrect code. Please check your SMS and try again." };
  }

  redirect("/profile");
}
