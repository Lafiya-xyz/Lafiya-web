#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/check-types-sync.mjs
//
// Verifies that lib/supabase/types.ts is in sync with supabase/migrations/.
//
// Because this project uses hand-authored types (no `supabase gen types` step
// — see the comment at the top of lib/supabase/types.ts for why), there is no
// generated file to diff against. Instead this script performs two checks:
//
//   1. Table coverage: every CREATE TABLE in the migration files has a matching
//      entry in the Database.public.Tables map inside types.ts.
//
//   2. Enum coverage: every CREATE TYPE ... AS ENUM in the migrations has either:
//      (a) an entry in Database.public.Enums, OR
//      (b) an exported TypeScript `type` alias in lib/supabase/types.ts
//      (since this project uses standalone aliases rather than always listing
//      every SQL enum in the Database.public.Enums block).
//
// If any table introduced by a migration is missing from types.ts the script
// exits 1 with a clear, actionable message so CI fails and tells you exactly
// what to add.
//
// Usage:
//   node scripts/check-types-sync.mjs
//   npm run types:check
//
// Exit codes:
//   0  — types.ts covers all tables and enums found in migrations
//   1  — one or more are missing; the missing items are printed
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const TYPES_FILE = join(ROOT, "lib", "supabase", "types.ts");

// ── Load files ───────────────────────────────────────────────────────────────
function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    console.error(`Failed to read ${path}: ${err.message}`);
    process.exit(1);
  }
}

const typesContent = readFile(TYPES_FILE);
let migrationFiles;
try {
  migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
} catch (err) {
  console.error(`Failed to read migrations directory: ${err.message}`);
  process.exit(1);
}

// ── Extract tables and enums from migrations ─────────────────────────────────
// Matches: CREATE TABLE [IF NOT EXISTS] [schema.]tableName
const TABLE_PATTERN = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
// Matches: CREATE TYPE [schema.]typeName AS ENUM
const ENUM_PATTERN = /CREATE\s+TYPE\s+(?:public\.)?(\w+)\s+AS\s+ENUM/gi;

// Tables that are static/seed config and don't need a typed app query entry.
// These are lookup/reference tables the app reads via typed RPCs, not directly.
const SKIP_TABLES = new Set([
  "schema_migrations",
  "buckets",
  "objects",
  "migrations",
  "consent_purposes", // static seed table; app reads it only via typed RPCs
]);

const tablesInMigrations = new Set();
const enumsInMigrations = new Set();

for (const file of migrationFiles) {
  const sql = readFile(join(MIGRATIONS_DIR, file));

  let m;
  while ((m = TABLE_PATTERN.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    if (!SKIP_TABLES.has(name)) tablesInMigrations.add(name);
  }
  TABLE_PATTERN.lastIndex = 0;

  while ((m = ENUM_PATTERN.exec(sql)) !== null) {
    enumsInMigrations.add(m[1].toLowerCase());
  }
  ENUM_PATTERN.lastIndex = 0;
}

// ── Extract coverage from types.ts ──────────────────────────────────────────
// The types file uses 4-space indentation at the top level of Database, and
// 6-space indentation for keys inside Tables/Enums/Functions blocks.

// Extract content between a named block and its closing brace using
// brace-depth counting, reliable regardless of nested objects.
function extractBlock(content, blockName) {
  const marker = `    ${blockName}: {`;
  const start = content.indexOf(marker);
  if (start === -1) return null;
  let depth = 0;
  let i = content.indexOf("{", start);
  const blockStart = i + 1;
  for (; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return content.slice(blockStart, i);
    }
  }
  return null;
}

const tablesInTypes = new Set();
const enumKeysInTypes = new Set(); // keys in Database.public.Enums block

const tablesBlock = extractBlock(typesContent, "Tables");
if (tablesBlock) {
  const keyPattern = /^ {6}(\w+):\s*\{/gm;
  let km;
  while ((km = keyPattern.exec(tablesBlock)) !== null) {
    tablesInTypes.add(km[1].toLowerCase());
  }
}

const enumsBlock = extractBlock(typesContent, "Enums");
if (enumsBlock) {
  const keyPattern = /^ {6}(\w+):/gm;
  let km;
  while ((km = keyPattern.exec(enumsBlock)) !== null) {
    enumKeysInTypes.add(km[1].toLowerCase());
  }
}

// Also collect all exported `export type Xyz = ...` aliases from the file.
// This catches enums typed as standalone aliases (not in the Enums block).
// We normalize by removing trailing `_enum`, `_status`, `_state` suffixes to
// match SQL enum names like `blood_group_enum` → `blood_group` → compare with
// `BloodGroup` / `blood_group_enum` in Enums block.
const exportedTypeNames = new Set(); // raw lowercased names
const TYPE_ALIAS_PATTERN = /^export\s+type\s+(\w+)\s*=/gm;
let tm;
while ((tm = TYPE_ALIAS_PATTERN.exec(typesContent)) !== null) {
  exportedTypeNames.add(tm[1].toLowerCase());
}

// ── Enum coverage check ──────────────────────────────────────────────────────
// For each SQL enum, we consider it covered if either:
// (a) the exact name appears in Database.public.Enums keys, OR
// (b) the name (with or without _enum suffix) matches an exported type alias
function enumIsCovered(sqlEnumName) {
  // Direct match in Enums block
  if (enumKeysInTypes.has(sqlEnumName)) return true;

  // Exported type alias with the same name
  if (exportedTypeNames.has(sqlEnumName)) return true;

  // Strip _enum suffix and check for matching exported alias
  // e.g. blood_group_enum → blood_group → look for BloodGroup (bloodgroup)
  const stripped = sqlEnumName.replace(/_enum$/, "");
  // Also check camelCase: blood_group → bloodgroup (normalize by removing _)
  const normalized = stripped.replace(/_/g, "");
  for (const alias of exportedTypeNames) {
    const normalizedAlias = alias.replace(/_/g, "");
    if (normalizedAlias === normalized) return true;
  }

  return false;
}

// ── Diff ─────────────────────────────────────────────────────────────────────
const missingTables = [...tablesInMigrations].filter(
  (t) => !tablesInTypes.has(t),
);
const missingEnums = [...enumsInMigrations].filter(
  (e) => !enumIsCovered(e),
);

// ── Report ───────────────────────────────────────────────────────────────────
const pass = missingTables.length === 0 && missingEnums.length === 0;

console.log(`Types sync check: lib/supabase/types.ts vs supabase/migrations/`);
console.log(`  Migrations scanned  : ${migrationFiles.length}`);
console.log(`  Tables in migrations: ${tablesInMigrations.size}`);
console.log(`  Tables in types     : ${tablesInTypes.size}`);
console.log(`  Enums in migrations : ${enumsInMigrations.size}`);
console.log(`  Enums covered       : ${enumsInMigrations.size - missingEnums.length}/${enumsInMigrations.size}`);
console.log();

if (missingTables.length > 0) {
  console.error("ERROR: The following tables are defined in migrations but missing from lib/supabase/types.ts:");
  for (const t of missingTables) {
    console.error(`  ✗  ${t}`);
  }
  console.error();
  console.error("  To fix: add a Row/Insert/Update/Relationships entry for each missing table");
  console.error("  inside the `Database.public.Tables` map in lib/supabase/types.ts.");
  console.error("  See the existing entries for examples. Remember: use `type` aliases, never `interface`.");
  console.error();
  console.error("  Run `npm run types:check` again after updating.");
  console.error();
}

if (missingEnums.length > 0) {
  console.error("ERROR: The following enums are defined in migrations but not covered in lib/supabase/types.ts:");
  for (const e of missingEnums) {
    console.error(`  ✗  ${e}`);
  }
  console.error();
  console.error("  To fix: either add an exported `type` alias for each missing enum,");
  console.error("  or add it to the `Database.public.Enums` map in lib/supabase/types.ts.");
  console.error("  Remember: use `type` aliases, never `interface`.");
  console.error();
  console.error("  Run `npm run types:check` again after updating.");
  console.error();
}

if (pass) {
  console.log("✓ lib/supabase/types.ts covers all tables and enums in migrations.");
  process.exit(0);
} else {
  console.error(
    "lib/supabase/types.ts is out of sync with supabase/migrations/.",
  );
  console.error(
    "Update lib/supabase/types.ts by hand to match the current migrations,",
  );
  console.error(
    "then re-run `npm run types:check` to confirm.",
  );
  process.exit(1);
}
