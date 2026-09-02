#!/usr/bin/env node
// ---------------------------------------------------------------------------
// verify-supabase-types.mjs
//
// Checks that lib/supabase/types.ts is consistent with the current set of
// SQL migrations in supabase/migrations/.
//
// This project uses hand-authored types (no `supabase gen types` step — see
// CONTRIBUTING.md §"Critical Constraint: Hand-Authored Types"). This script
// therefore does NOT regenerate the file automatically; instead it verifies
// that:
//
//  1. Every public table created in a migration has a corresponding Row type
//     in lib/supabase/types.ts (e.g. `profiles` → `ProfileRow` / `type …`).
//  2. Every column of a public table that appears in a migration is referenced
//     at least once in types.ts.
//  3. No migration was added or modified after types.ts was last touched
//     (mtime-based guard, disabled in CI where mtimes are not meaningful).
//
// Exit codes:
//   0 — types appear consistent with migrations
//   1 — one or more checks failed; message explains what to fix
//
// Usage:
//   node scripts/verify-supabase-types.mjs
//
// In CI this runs as a step in the `test` job (see .github/workflows/ci.yml).
// Locally run it after adding or modifying a migration:
//   node scripts/verify-supabase-types.mjs
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const TYPES_FILE = join(ROOT, "lib", "supabase", "types.ts");

// ── Helpers ──────────────────────────────────────────────────────────────────

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    console.error(`Cannot read ${path}: ${err.message}`);
    process.exit(1);
  }
}

function extractPublicTables(sql) {
  // Matches: CREATE TABLE [IF NOT EXISTS] public.<name>
  const matches = [
    ...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi),
  ];
  return matches.map((m) => m[1]);
}

function extractColumns(sql, tableName) {
  // Crude but effective: find the CREATE TABLE block for the given table and
  // extract column names from it. Stops at the first ');'.
  const tableRe = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${tableName}\\s*\\(([\\s\\S]*?)\\);`,
    "i",
  );
  const match = sql.match(tableRe);
  if (!match) return [];
  const body = match[1];
  const columnRe = /^\s{0,8}([a-z_][a-z0-9_]*)\s+[a-z]/gim;
  const cols = [];
  let m;
  while ((m = columnRe.exec(body)) !== null) {
    const col = m[1].toLowerCase();
    // Skip SQL constraint / DDL keywords — these open a constraint declaration,
    // not a column definition.
    if (
      /^(primary|unique|foreign|check|constraint|exclude|references|index|on|not|null|default|generated|always|stored|as)$/i.test(col)
    )
      continue;
    cols.push(col);
  }
  return [...new Set(cols)];
}

// ── Load files ────────────────────────────────────────────────────────────────

const typesContent = readFile(TYPES_FILE);
const typesLower = typesContent.toLowerCase();

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// ── Check 1: mtime guard (local-only) ────────────────────────────────────────
//
// In CI, git checkout resets all mtimes so this check would always fire.
// We skip it when the CI env var is set.

const failures = [];

if (!process.env.CI) {
  const typesMtime = statSync(TYPES_FILE).mtimeMs;
  const latestMigrationMtime = Math.max(
    ...migrationFiles.map((f) =>
      statSync(join(MIGRATIONS_DIR, f)).mtimeMs,
    ),
  );
  if (latestMigrationMtime > typesMtime) {
    failures.push(
      `A migration file is newer than lib/supabase/types.ts.\n` +
        `  You likely added a migration without updating the types.\n` +
        `  Update lib/supabase/types.ts to match, then re-run this check.\n` +
        `  (To regenerate guidance, see CONTRIBUTING.md §"Supabase Database Migrations")`,
    );
  }
}

// ── Check 2: every public table has a type entry ─────────────────────────────

const allSql = migrationFiles
  .map((f) => readFile(join(MIGRATIONS_DIR, f)))
  .join("\n");

// Tables defined across all migrations
const allTables = [
  ...new Set(
    migrationFiles.flatMap((f) =>
      extractPublicTables(readFile(join(MIGRATIONS_DIR, f))),
    ),
  ),
];

// Tables that appear in ALTER TABLE ... ADD COLUMN are accounted for via their
// original CREATE TABLE entry; we only need new table names here.

for (const table of allTables) {
  // Accept any mention of the table name in a type alias context.
  // We look for the snake_case name in the types file; a contributor must use
  // it somewhere (either as a type alias name or as a property).
  if (!typesLower.includes(table.toLowerCase())) {
    failures.push(
      `Table 'public.${table}' is defined in migrations but has no corresponding\n` +
        `  entry in lib/supabase/types.ts.\n` +
        `  Add a row type for it (use \`type\` alias, not \`interface\`) and update\n` +
        `  the Database type accordingly.\n` +
        `  See CONTRIBUTING.md §"Critical Constraint: Hand-Authored Types".`,
    );
  }
}

// ── Check 3: spot-check critical columns ─────────────────────────────────────
//
// For each table, extract its columns from the CREATE TABLE statement and
// verify each one is mentioned in types.ts. This catches the most common
// mistake: adding a column in a migration and forgetting to update the type.
//
// We skip internal/system columns (id, created_at, updated_at) only if the
// table already has them — those are ubiquitous and always expected.
//
// We also accept ALTER TABLE … ADD COLUMN as a signal that the column exists
// even if the CREATE TABLE block was in an earlier migration.

const UBIQUITOUS = new Set(["id", "created_at", "updated_at", "deleted_at"]);

// Collect all column names mentioned in ALTER TABLE … ADD COLUMN statements
// across all migrations so we can check them against types.ts too.
const alterColumnRe =
  /alter\s+table\s+(?:public\.)?([a-z0-9_]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi;
const alterColumns = {}; // table → Set<columnName>
let am;
while ((am = alterColumnRe.exec(allSql)) !== null) {
  const tbl = am[1];
  const col = am[2].toLowerCase();
  if (!alterColumns[tbl]) alterColumns[tbl] = new Set();
  alterColumns[tbl].add(col);
}

for (const table of allTables) {
  // Gather columns from all migration files (CREATE TABLE + ALTER TABLE ADD COLUMN)
  const tableSql = migrationFiles
    .map((f) => readFile(join(MIGRATIONS_DIR, f)))
    .join("\n");
  const createCols = extractColumns(tableSql, table);
  const alterCols = alterColumns[table] ? [...alterColumns[table]] : [];
  const allCols = [...new Set([...createCols, ...alterCols])];

  for (const col of allCols) {
    if (UBIQUITOUS.has(col)) continue;
    if (!typesLower.includes(col.toLowerCase())) {
      failures.push(
        `Column '${col}' on table 'public.${table}' is defined in migrations but\n` +
          `  is not mentioned in lib/supabase/types.ts.\n` +
          `  Update lib/supabase/types.ts to include this column.\n` +
          `  Run: node scripts/verify-supabase-types.mjs   to re-check.`,
      );
    }
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(
    `verify-supabase-types: lib/supabase/types.ts appears consistent with ${migrationFiles.length} migration(s). ✓`,
  );
  process.exit(0);
}

console.error(
  `\n⚠  verify-supabase-types: ${failures.length} issue(s) found\n`,
);
for (let i = 0; i < failures.length; i++) {
  console.error(`  [${i + 1}] ${failures[i]}\n`);
}
console.error(
  `Types are out of date. Update lib/supabase/types.ts to match the current\n` +
    `migrations, then re-run:\n\n` +
    `  node scripts/verify-supabase-types.mjs\n\n` +
    `See CONTRIBUTING.md §"Supabase Database Migrations" for guidance.\n`,
);
process.exit(1);
