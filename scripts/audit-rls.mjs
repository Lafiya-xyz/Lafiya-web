#!/usr/bin/env node
/**
 * Supabase database linter (issue #791).
 *
 * Checks:
 * 1. RLS enabled on all public tables.
 * 2. No client-facing policies with a constant `true` predicate (unless
 *    explicitly allowlisted).
 * 3. No `auth.uid()` bare function calls in policy predicates — must use
 *    `(select auth.uid())` subselect to avoid per-row re-evaluation.
 * 4. Every column referenced in a policy USING / WITH CHECK predicate on
 *    a public table has at least one index covering it (index-usage gate).
 *
 * Exit 1 on any failure so CI treats this as a hard gate.
 */

import { execFileSync } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const allowlistedTruePolicies = new Set(
  (process.env.RLS_TRUE_POLICY_ALLOWLIST || '').split(',').map((v) => v.trim()).filter(Boolean),
);

function query(sql) {
  return execFileSync(
    'psql',
    [
      databaseUrl,
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--field-separator', '\t',
      '--command', sql,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

const tables = query(
  `select n.nspname, c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') order by c.relname`,
);

const policies = query(
  `select schemaname, tablename, policyname, roles::text,
  coalesce(qual, ''), coalesce(with_check, '')
  from pg_policies where schemaname = 'public' order by tablename, policyname`,
);

// All indexed columns on public tables (any index type).
const indexedColumns = new Set(
  query(
    `select t.relname || '.' || a.attname
    from pg_index ix
    join pg_class t  on t.oid  = ix.indrelid
    join pg_class i  on i.oid  = ix.indexrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
    where n.nspname = 'public'`,
  ).map(([col]) => col).filter(Boolean),
);

const failures = [];

// ── Check 1: RLS enabled ─────────────────────────────────────────────────────
for (const [schema, table, rls] of tables) {
  if (rls !== 't') failures.push(`${schema}.${table}: row-level security is disabled`);
}

// ── Check 2 & 3 & 4: policy predicate checks ─────────────────────────────────
for (const [schema, table, name, roles, using, check] of policies) {
  const appliesToClient = /anon|authenticated/.test(roles);

  // Check 2: constant true predicate
  const isTrue = /^(\(true\)|true)$/.test(using.trim()) || /^(\(true\)|true)$/.test(check.trim());
  if (appliesToClient && isTrue && !allowlistedTruePolicies.has(`${table}.${name}`)) {
    failures.push(`${schema}.${table}.${name}: client policy contains a constant true predicate`);
  }

  // Check 3: bare auth.uid() call without subselect (performance anti-pattern)
  // Correct form: (select auth.uid()). Bare auth.uid() is re-evaluated per row.
  const bareAuthUid = /(?<!\(select\s)auth\.uid\(\)/i;
  for (const predicate of [using, check]) {
    if (predicate && bareAuthUid.test(predicate)) {
      failures.push(
        `${schema}.${table}.${name}: uses bare auth.uid() — rewrite as (select auth.uid()) to avoid per-row re-evaluation`,
      );
      break;
    }
  }

  // Check 4: unindexed predicate columns
  // Extract column names referenced in predicates via a simple heuristic:
  // any word immediately following a comparison operator likely references a column.
  const predicateText = `${using} ${check}`;
  // Match patterns like: col = ..., ... = col, col IS ..., etc.
  const colRefs = [
    ...predicateText.matchAll(/\b([a-z_][a-z0-9_]*)\s*(?:=|<|>|!=|<>|is\b)/gi),
    ...predicateText.matchAll(/(?:=|<|>|!=|<>)\s*([a-z_][a-z0-9_]*)\b/gi),
  ].map((m) => m[1]).filter(
    // Exclude SQL keywords and functions
    (col) =>
      col &&
      !['true', 'false', 'null', 'and', 'or', 'not', 'in', 'is', 'select', 'auth', 'uid'].includes(
        col.toLowerCase(),
      ),
  );

  for (const col of new Set(colRefs)) {
    const tableCol = `${table}.${col}`;
    if (!indexedColumns.has(tableCol)) {
      failures.push(
        `${schema}.${table}.${name}: predicate column "${col}" has no index — add one or this will cause a seqscan on every policy evaluation`,
      );
    }
  }
}

if (failures.length) {
  console.error('RLS audit failed:\n' + failures.map((f) => `- ${f}`).join('\n'));
  process.exit(1);
}
console.log(
  `RLS audit passed: ${tables.length} public tables and ${policies.length} policies checked.`,
);
