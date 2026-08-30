"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signUp } from "./actions";

export default function SignUpPage() {
  const [state, formAction, isPending] = useActionState(signUp, undefined);

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-24 dark:bg-black">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          Create your card
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Free, patient-owned. Takes a minute.
        </p>

        <form action={formAction} className="mt-8 flex flex-col gap-4">
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
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
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
              minLength={8}
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>

          <div className="flex items-start gap-2">
            <input
              id="consent"
              name="consent"
              type="checkbox"
              required
              className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-950 focus:ring-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-zinc-50"
            />
            <label
              htmlFor="consent"
              className="text-sm text-zinc-600 dark:text-zinc-400"
            >
              I consent to the collection and processing of my health data in accordance with the{" "}
              <Link
                href="/privacy"
                className="font-medium text-zinc-950 underline dark:text-zinc-50"
              >
                Privacy Notice
              </Link>
              .
            </label>
          </div>

          {state?.error ? (
            <p className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}
          {state?.info ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              {state.info}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={isPending}
            className="mt-2 flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {isPending ? "Creating…" : "Create your card"}
          </button>
        </form>

        <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
          Already have a card?{" "}
          <Link
            href="/signin"
            className="font-medium text-zinc-950 underline dark:text-zinc-50"
          >
            Sign in
          </Link>
        </p>

        <p role="note" className="mt-6 text-xs text-zinc-500 dark:text-zinc-500">
          Lafiya is pre-alpha software on the Stellar testnet, not yet
          audited, and not a medical device. Not a substitute for
          professional medical judgment.
        </p>
      </div>
    </div>
  );
}
