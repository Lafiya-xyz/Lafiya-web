import { describe, expect, it } from "vitest";
import { findUnpinnedSecurityDefinerFunctions } from "./lint-migrations.mjs";

describe("findUnpinnedSecurityDefinerFunctions", () => {
  it("accepts SECURITY DEFINER functions with an empty search_path", () => {
    expect(
      findUnpinnedSecurityDefinerFunctions(
        "create function public.safe() returns void security definer set search_path = '' as $$ begin null; end; $$;",
        "safe.sql",
      ),
    ).toEqual([]);
  });

  it("rejects SECURITY DEFINER functions with mutable or missing search_path", () => {
    const sql = `
      create function public.mutable() returns void
      security definer set search_path = public, pg_temp as $$ begin null; end; $$;
      create function public.unset() returns void
      security definer as $$ begin null; end; $$;
    `;

    expect(findUnpinnedSecurityDefinerFunctions(sql, "unsafe.sql")).toEqual([
      "unsafe.sql: SECURITY DEFINER function must set search_path = ''",
      "unsafe.sql: SECURITY DEFINER function must set search_path = ''",
    ]);
  });

  it("does not require a search_path on invoker functions", () => {
    expect(
      findUnpinnedSecurityDefinerFunctions(
        "create function public.invoker() returns void as $$ begin null; end; $$;",
        "invoker.sql",
      ),
    ).toEqual([]);
  });
});
