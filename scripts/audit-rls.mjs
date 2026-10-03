#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const allowlistedTruePolicies = new Set(
  (process.env.RLS_TRUE_POLICY_ALLOWLIST || '').split(',').map((v) => v.trim()).filter(Boolean),
);

function query(sql) {
  return execFileSync('psql', [databaseUrl, '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '\t', '--command', sql], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
}

const tables = query(`select n.nspname, c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') order by c.relname`);
const policies = query(`select schemaname, tablename, policyname, roles::text,
  coalesce(qual, ''), coalesce(with_check, '')
  from pg_policies where schemaname = 'public' order by tablename, policyname`);
const failures = [];
for (const [schema, table, rls] of tables) {
  if (rls !== 't') failures.push(`${schema}.${table}: row-level security is disabled`);
}
for (const [schema, table, name, roles, using, check] of policies) {
  const appliesToClient = /anon|authenticated/.test(roles);
  const isTrue = /^(\(true\)|true)$/.test(using.trim()) || /^(\(true\)|true)$/.test(check.trim());
  if (appliesToClient && isTrue && !allowlistedTruePolicies.has(`${table}.${name}`)) {
    failures.push(`${schema}.${table}.${name}: client policy contains a constant true predicate`);
  }
}
if (failures.length) {
  console.error('RLS audit failed:\n' + failures.map((f) => `- ${f}`).join('\n'));
  process.exit(1);
}
console.log(`RLS audit passed: ${tables.length} public tables and ${policies.length} policies checked.`);
