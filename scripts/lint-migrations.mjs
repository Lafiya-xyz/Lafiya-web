#!/usr/bin/env node
// Migration lint: enforces unique, strictly increasing Supabase migration
// versions and a canonical filename shape.
//
// Supabase keys supabase_migrations.schema_migrations on the numeric version
// prefix, so two files sharing a version can silently skip one of them, and
// out-of-order versions make the applied history depend on filename sort.
//
// Usage: node scripts/lint-migrations.mjs [migrationsDir]
// Exits non-zero with an actionable message on the first violation.

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILENAME_RE = /^(\d{14})_[a-z0-9_]+\.sql$/;

const migrationsDir = resolve(process.argv[2] ?? 'supabase/migrations');

function fail(message) {
  console.error(`\n[migration-lint] ${message}\n`);
  process.exit(1);
}

let entries;
try {
  entries = readdirSync(migrationsDir);
} catch (err) {
  fail(`Could not read migrations directory ${migrationsDir}: ${err.message}`);
}

const files = entries
  .filter((name) => statSync(join(migrationsDir, name)).isFile())
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.log('[migration-lint] No migration files found; nothing to check.');
  process.exit(0);
}

const seen = new Map();
let previousVersion = null;
let previousFile = null;

for (const file of files) {
  const match = FILENAME_RE.exec(file);
  if (!match) {
    fail(
      `Malformed migration filename: ${file}\n` +
        `  Expected: <14-digit version>_<lower_snake_case>.sql\n` +
        `  Example:  20260820130000_add_widgets_table.sql`,
    );
  }

  const version = match[1];

  if (seen.has(version)) {
    fail(
      `Duplicate migration version ${version}:\n` +
        `  ${seen.get(version)}\n` +
        `  ${file}\n` +
        `  Rename one file to a unique later timestamp (e.g. ${nextVersion(version)}).\n` +
        `  If a remote database already recorded ${version}, reconcile it with\n` +
        `  \`supabase migration repair\` — see docs/operations/migration-history-repair.md.`,
    );
  }
  seen.set(version, file);

  if (previousVersion !== null && version <= previousVersion) {
    fail(
      `Migration versions are not strictly increasing:\n` +
        `  ${previousFile} (${previousVersion})\n` +
        `  ${file} (${version})\n` +
        `  A new migration must use a version later than the newest one on main.\n` +
        `  Rebase and re-timestamp the migration instead of reordering history.`,
    );
  }

  previousVersion = version;
  previousFile = file;
}

console.log(
  `[migration-lint] OK — ${files.length} migration(s), versions unique and strictly increasing.`,
);

function nextVersion(version) {
  const bumped = BigInt(version) + 10000n;
  return bumped.toString().padStart(14, '0');
}
