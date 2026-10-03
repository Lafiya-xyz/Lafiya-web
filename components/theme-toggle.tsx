"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const THEME_KEY = "lafiya-theme";

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function applyTheme(next: Theme) {
  const root = document.documentElement;
  const effective = next === "system" ? getSystemTheme() : next;
  root.classList.remove("light", "dark");
  root.classList.add(effective);
}

/**
 * CSS-only theme control for public, zero-client-JS routes such as `/card/*`.
 *
 * This renders a native radio group that drives the `light`/`dark` classes on
 * `<html>` via the `:has()` selector (see the theme stylesheet), so the card
 * route ships no client component while still honouring the user's choice.
 * The selection is persisted by the same `lafiya-theme` key used by
 * `ThemeToggle`, so the two controls stay in sync across the app.
 */
export function ThemeToggleStatic() {
  return (
    <fieldset
      className="theme-toggle-static flex items-center gap-1 rounded-full border border-zinc-200 p-1 dark:border-zinc-700"
      aria-label="Theme"
    >
      <legend className="sr-only">Theme</legend>
      {(["light", "system", "dark"] as Theme[]).map((option) => (
        <label
          key={option}
          className="cursor-pointer rounded-full px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900 has-[:checked]:bg-zinc-900 has-[:checked]:text-white dark:text-zinc-400 dark:hover:text-zinc-100 dark:has-[:checked]:bg-white dark:has-[:checked]:text-zinc-900"
        >
          <input
            type="radio"
            name="theme"
            value={option}
            defaultChecked={option === "system"}
            className="sr-only"
          />
          {option === "light" ? "Light" : option === "dark" ? "Dark" : "System"}
        </label>
      ))}
    </fieldset>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const initial = getInitialTheme();
    setTheme(initial);
    applyTheme(initial);
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (getInitialTheme() === "system") {
        applyTheme("system");
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  function handleChange(next: Theme) {
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle theme"
        className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <span className="sr-only">Toggle theme</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 rounded-full border border-zinc-200 p-1 dark:border-zinc-700">
      {(["light", "system", "dark"] as Theme[]).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => handleChange(option)}
          aria-pressed={theme === option}
          className={`rounded-full px-2 py-1 text-xs font-medium transition-colors ${
            theme === option
              ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
              : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          }`}
        >
          {option === "light" ? "Light" : option === "dark" ? "Dark" : "System"}
        </button>
      ))}
    </div>
  );
}
