"use client";

/**
 * Issue #530: Sign-in page with optional phone OTP tab.
 *
 * When NEXT_PUBLIC_PHONE_OTP_ENABLED=true, a tab switcher is shown so users
 * can choose between email/password and phone OTP. The email flow is
 * completely unaffected when the flag is off (or unset).
 */

import Link from "next/link";
import { useState } from "react";
import { useActionState } from "react";

import { signIn } from "./actions";
import { PhoneOtpForm } from "./phone-otp-form";

const phoneOtpEnabled =
  process.env.NEXT_PUBLIC_PHONE_OTP_ENABLED === "true";

type Tab = "email" | "phone";

export default function SignInPage() {
  const [state, formAction, isPending] = useActionState(signIn, undefined);
  const [activeTab, setActiveTab] = useState<Tab>("email");

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-24 dark:bg-black">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          Sign in
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Access your Lafiya card.
        </p>

        {/* Tab switcher — only rendered when feature flag is on */}
        {phoneOtpEnabled ? (
          <div
            role="tablist"
            aria-label="Sign-in method"
            className="mt-6 flex rounded-lg border border-zinc-200 p-1 dark:border-zinc-800"
          >
            <button
              role="tab"
              aria-selected={activeTab === "email"}
              aria-controls="signin-panel-email"
              id="signin-tab-email"
              type="button"
              onClick={() => setActiveTab("email")}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:focus:ring-zinc-600 ${
                activeTab === "email"
                  ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-900 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
              }`}
            >
              Email
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "phone"}
              aria-controls="signin-panel-phone"
              id="signin-tab-phone"
              type="button"
              onClick={() => setActiveTab("phone")}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:focus:ring-zinc-600 ${
                activeTab === "phone"
                  ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-900 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
              }`}
            >
              Phone
            </button>
          </div>
        ) : null}

        {/* Email/password panel */}
        <div
          id="signin-panel-email"
          role={phoneOtpEnabled ? "tabpanel" : undefined}
          aria-labelledby={phoneOtpEnabled ? "signin-tab-email" : undefined}
          hidden={phoneOtpEnabled && activeTab !== "email"}
          className="mt-8"
        >
          <form action={formAction} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                id="rememberMe"
                name="rememberMe"
                type="checkbox"
                defaultChecked
                className="h-4 w-4 rounded border-zinc-300 text-zinc-950 focus:ring-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-zinc-50"
              />
              <label
                htmlFor="rememberMe"
                className="text-sm text-zinc-700 dark:text-zinc-300"
              >
                Stay signed in
              </label>
            </div>

            {state?.error ? (
              <p className="text-sm text-red-600 dark:text-red-400">
                {state.error}
              </p>
            ) : null}

            <button
              type="submit"
              data-testid="signin-submit"
              disabled={isPending}
              className="mt-2 flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 active:bg-zinc-700 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-zinc-950 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:active:bg-zinc-300 dark:disabled:bg-zinc-50 dark:focus:ring-zinc-600"
            >
              {isPending ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        {/* Phone OTP panel */}
        {phoneOtpEnabled ? (
          <div
            id="signin-panel-phone"
            role="tabpanel"
            aria-labelledby="signin-tab-phone"
            hidden={activeTab !== "phone"}
            className="mt-8"
          >
            <PhoneOtpForm />
          </div>
        ) : null}

        <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
          Don&apos;t have a card yet?{" "}
          <Link
            href="/signup"
            className="font-medium text-zinc-950 underline focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none rounded px-1 dark:text-zinc-50 dark:focus:ring-zinc-600"
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
