#!/usr/bin/env node
// Generates the Record of Processing Activities (RoPA) from code-level
// annotations stored in PostgreSQL comments (pg_description).
//
// Convention: table and column comments may contain a JSON object with the
// following keys:
//   purpose    - why the data is processed (e.g. "emergency_care")
//   basis      - legal basis (e.g. "consent", "legal_obligation")
//   retention  - retention policy (e.g. "account_lifetime")
//   recipients - array of recipients / processors (optional)
//   phi        - boolean, marks the table as PHI-bearing (table comments only)
//
// Example:
//   comment on column public.patients.allergies is
//     '{"purpose":"emergency_care","basis":"consent","retention":"account_lifetime"}';
//
// Usage:
//   node scripts/generate-ropa.mjs            # write docs/compliance/ropa.md
//   node scripts/generate-ropa.mjs --check    # fail if the committed copy is stale
//
// The script reads the live catalog via DATABASE_URL (or PG* env vars) using
// the `psql` client, so it works after `supabase db reset` without extra deps.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outputPath = resolve(repoRoot, 'docs/compliance/ropa.md');

const ANNOTATION_KEYS = ['purpose', 'basis', 'retention', 'recipients'];

// Query pg_description for table and column comments, joined with the
// information_schema so we can enumerate every column even when unannotated.
const QUERY = `
  select
    n.nspname as schema_name,
    c.relname as table_name,
    a.attname as column_name,
    a.attnum as column_position,
    obj_description(c.oid, 'pg_class') as table_comment,
    col_description(c.oid, a.attnum) as column_comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where c.relkind = 'r'
    and a.attnum > 0
    and not a.attisdropped
    and n.nspname not in ('pg_catalog', 'information_schema')
  order by n.nspname, c.relname, a.attnum;
`;

function runPsql(query) {
  const args = ['-X', '-A', '-t', '-F', '\u0001', '-c', query];
  if (process.env.DATABASE_URL) {
    args.push(process.env.DATABASE_URL);
  }
  const out = execFileSync('psql', args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

function parseAnnotation(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function isPhiTable(tableComment) {
  const annotation = parseAnnotation(tableComment);
  return Boolean(annotation && annotation.phi === true);
}

function collectRows(raw) {
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split('\u0001');
    if (parts.length < 6) continue;
    const [schemaName, tableName, columnName, columnPosition, tableComment, columnComment] = parts;
    rows.push({
      schemaName,
      tableName,
      columnName,
      columnPosition: Number(columnPosition),
      tableComment: tableComment || null,
      columnComment: columnComment || null,
    });
  }
  return rows;
}

function groupTables(rows) {
  const tables = new Map();
  for (const row of rows) {
    const key = `${row.schemaName}.${row.tableName}`;
    if (!tables.has(key)) {
      tables.set(key, {
        schemaName: row.schemaName,
        tableName: row.tableName,
        tableComment: row.tableComment,
        phi: isPhiTable(row.tableComment),
        columns: [],
      });
    }
    const table = tables.get(key);
    if (!table.tableComment && row.tableComment) table.tableComment = row.tableComment;
    table.columns.push({
      name: row.columnName,
      annotation: parseAnnotation(row.columnComment),
    });
  }
  return [...tables.values()];
}

function findUnannotatedPhiColumns(tables) {
  const problems = [];
  for (const table of tables) {
    if (!table.phi) continue;
    for (const column of table.columns) {
      if (!column.annotation) {
        problems.push(`${table.schemaName}.${table.tableName}.${column.name}`);
      } else {
        for (const key of ANNOTATION_KEYS) {
          if (key === 'recipients') continue;
          if (!column.annotation[key]) {
            problems.push(`${table.schemaName}.${table.tableName}.${column.name} (missing "${key}")`);
          }
        }
      }
    }
  }
  return problems;
}

function formatRecipients(recipients) {
  if (!recipients) return '—';
  if (Array.isArray(recipients)) return recipients.join(', ') || '—';
  return String(recipients);
}

function renderRopa(tables) {
  const lines = [];
  lines.push('# Record of Processing Activities (RoPA)');
  lines.push('');
  lines.push('> This document is generated from code-level annotations in the database');
  lines.push('> schema. Do not edit by hand — run `node scripts/generate-ropa.mjs`.');
  lines.push('');
  lines.push('Each table and column carries a JSON annotation describing its purpose,');
  lines.push('legal basis, retention policy, and recipients. Tables marked with');
  lines.push('`"phi": true` are PHI-bearing and every column must be annotated.');
  lines.push('');

  const phiTables = tables.filter((t) => t.phi);
  const otherTables = tables.filter((t) => !t.phi);

  const renderTable = (table) => {
    lines.push(`## ${table.schemaName}.${table.tableName}`);
    lines.push('');
    if (table.phi) lines.push('**PHI-bearing:** yes');
    lines.push('');
    lines.push('| Column | Purpose | Legal basis | Retention | Recipients |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const column of table.columns) {
      const a = column.annotation || {};
      lines.push(
        `| ${column.name} | ${a.purpose || '—'} | ${a.basis || '—'} | ${a.retention || '—'} | ${formatRecipients(a.recipients)} |`,
      );
    }
    lines.push('');
  };

  if (phiTables.length) {
    lines.push('## PHI-bearing tables');
    lines.push('');
    for (const table of phiTables) renderTable(table);
  }

  if (otherTables.length) {
    lines.push('## Other tables');
    lines.push('');
    for (const table of otherTables) renderTable(table);
  }

  return lines.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const raw = runPsql(QUERY);
  const tables = groupTables(collectRows(raw));

  const problems = findUnannotatedPhiColumns(tables);
  if (problems.length) {
    console.error('Unannotated PHI columns detected:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nAnnotate these columns with a JSON comment before generating the RoPA.');
    process.exit(1);
  }

  const document = renderRopa(tables);

  if (check) {
    let existing = '';
    try {
      existing = readFileSync(outputPath, 'utf8');
    } catch {
      console.error(`Missing ${outputPath}. Run: node scripts/generate-ropa.mjs`);
      process.exit(1);
    }
    if (existing !== document) {
      console.error('docs/compliance/ropa.md is stale. Run: node scripts/generate-ropa.mjs');
      process.exit(1);
    }
    console.log('RoPA is up to date.');
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, document, 'utf8');
  console.log(`Wrote ${outputPath}`);
}

main();
