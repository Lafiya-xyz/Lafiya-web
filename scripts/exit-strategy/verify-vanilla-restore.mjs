/**
 * verify-vanilla-restore.mjs
 *
 * Post-restore verification: checks that a vanilla Postgres instance that has
 * had all Lafiya migrations applied contains the expected schema structure and
 * can execute the core invariants (RPC, RLS, commitment scheme).
 *
 * Uses psql via child_process — no extra npm packages required.
 *
 * Usage:
 *   TARGET_DATABASE_URL=postgres://... node scripts/exit-strategy/verify-vanilla-restore.mjs
 *
 * Exit codes:
 *   0  All checks passed
 *   1  One or more checks failed
 */

import { spawnSync } from "node:child_process";

const DATABASE_URL = process.env.TARGET_DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    "TARGET_DATABASE_URL is required. Set it to a vanilla Postgres connection string.",
  );
  process.exit(1);
}

const passed = [];
const failed = [];

/**
 * Run a SQL query via psql and return stdout.
 * @param {string} sql
 * @returns {string}
 */
function psql(sql) {
  const result = spawnSync(
    "psql",
    [DATABASE_URL, "--no-psqlrc", "--tuples-only", "--no-align", "-c", sql],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `psql exited with code ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Assert a SQL query returns at least one non-empty row.
 * @param {string} name
 * @param {string} sql
 * @param {(output: string) => void} [assert]
 */
function check(name, sql, assert) {
  try {
    const output = psql(sql);
    if (assert) {
      assert(output);
    } else if (!output) {
      throw new Error("Query returned no rows");
    }
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed.push({ name, error: err.message });
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

console.log("Running vanilla-Postgres restore verification…\n");

// ── Schema presence ──────────────────────────────────────────────────────────

check(
  "public.profiles table exists",
  `SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'profiles'`,
);

check(
  "public.profile_secrets table exists",
  `SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'profile_secrets'`,
);

check(
  "auth.users table exists (stub)",
  `SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'auth' AND table_name = 'users'`,
);

check(
  "auth.uid() function exists",
  `SELECT 1 FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth' AND p.proname = 'uid'`,
);

// ── Enum types ────────────────────────────────────────────────────────────────

check(
  "blood_group_enum type exists",
  `SELECT 1 FROM pg_type WHERE typname = 'blood_group_enum'`,
);

check(
  "genotype_enum type exists",
  `SELECT 1 FROM pg_type WHERE typname = 'genotype_enum'`,
);

// ── RPC ───────────────────────────────────────────────────────────────────────

check(
  "get_emergency_card() function exists",
  `SELECT 1 FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_emergency_card'`,
);

check(
  "get_emergency_card() returns a row for the seeded profile",
  `SELECT name FROM public.get_emergency_card(
     (SELECT card_public_id FROM public.profiles LIMIT 1)
   )`,
);

// ── RLS (basic) ───────────────────────────────────────────────────────────────

check(
  "RLS is enabled on public.profiles",
  `SELECT relrowsecurity::text FROM pg_class
   WHERE relname = 'profiles' AND relnamespace = 'public'::regnamespace`,
  (out) => {
    if (out !== "t") throw new Error(`Expected 't', got '${out}'`);
  },
);

check(
  "RLS is enabled on public.profile_secrets",
  `SELECT relrowsecurity::text FROM pg_class
   WHERE relname = 'profile_secrets' AND relnamespace = 'public'::regnamespace`,
  (out) => {
    if (out !== "t") throw new Error(`Expected 't', got '${out}'`);
  },
);

// ── profile_secrets zero-policy check ────────────────────────────────────────

check(
  "profile_secrets has no RLS policies (zero-grant design)",
  `SELECT COUNT(*)::text FROM pg_policy
   WHERE polrelid = 'public.profile_secrets'::regclass`,
  (out) => {
    if (out !== "0") throw new Error(`Expected 0 policies, found ${out}`);
  },
);

// ── Commitment integrity ──────────────────────────────────────────────────────

check(
  "profile_secrets has a row for every profiles row",
  `SELECT COUNT(*)::text FROM public.profiles p
   WHERE NOT EXISTS (
     SELECT 1 FROM public.profile_secrets s WHERE s.user_id = p.user_id
   )`,
  (out) => {
    if (out !== "0")
      throw new Error(
        `${out} profiles row(s) have no corresponding profile_secrets row`,
      );
  },
);

// ── Storage schema stubs ──────────────────────────────────────────────────────

check(
  "storage.buckets table exists (stub)",
  `SELECT 1 FROM information_schema.tables
   WHERE table_schema = 'storage' AND table_name = 'buckets'`,
);

check(
  "storage.foldername() function exists (stub)",
  `SELECT 1 FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'storage' AND p.proname = 'foldername'`,
);

// ── Required roles ────────────────────────────────────────────────────────────

for (const role of ["anon", "authenticated", "service_role"]) {
  check(
    `role '${role}' exists`,
    `SELECT 1 FROM pg_roles WHERE rolname = '${role}'`,
  );
}

// ── pgcrypto ──────────────────────────────────────────────────────────────────

check(
  "pgcrypto gen_random_bytes() is available",
  `SELECT length(encode(gen_random_bytes(4), 'hex'))::text`,
  (out) => {
    if (out !== "8") throw new Error(`Expected 8-char hex, got '${out}'`);
  },
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(
  `\nResults: ${passed.length} passed, ${failed.length} failed\n`,
);

if (failed.length > 0) {
  console.error("Failed checks:");
  for (const { name, error } of failed) {
    console.error(`  ✗ ${name}: ${error}`);
  }
  process.exit(1);
}

console.log("All checks passed. Restore drill completed successfully.");
process.exit(0);
