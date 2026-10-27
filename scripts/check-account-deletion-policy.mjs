#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = resolve(repoRoot, "compliance/account-deletion-policy.json");

const CATALOG_QUERY = `
  with recursive direct_refs as (
    select a.attrelid as relation_id, a.attnum, a.attname
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'storage')
      and a.attnum > 0 and not a.attisdropped
      and (
        a.attname ~ '(^|_)(user|patient|guardian|requester|survivor|loser|chw|clinician|actor|owner|subject)(_user)?_id$'
        or (n.nspname = 'storage' and c.relname = 'objects' and a.attname = 'owner_id')
        or a.attname in ('created_by', 'approved_by')
      )
    union
    select con.conrelid, key_column.attnum, key_column.attname
    from pg_constraint con
    cross join lateral unnest(con.conkey) as key_attnum(attnum)
    join pg_attribute key_column
      on key_column.attrelid = con.conrelid and key_column.attnum = key_attnum.attnum
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
  ), linked_relations(relation_id, path) as (
    select distinct relation_id, array[relation_id]
    from direct_refs
    union all
    select con.conrelid, linked.path || con.conrelid
    from linked_relations linked
    join pg_constraint con on con.confrelid = linked.relation_id
    where con.contype = 'f'
      and not con.conrelid = any(linked.path)
  ), linked_tables as (
    select distinct relation_id from linked_relations
  ), linked_columns as (
    select relation_id, attnum, attname from direct_refs
    union
    select con.conrelid, key_column.attnum, key_column.attname
    from linked_tables linked
    join pg_constraint con on con.confrelid = linked.relation_id
    cross join lateral unnest(con.conkey) as key_attnum(attnum)
    join pg_attribute key_column
      on key_column.attrelid = con.conrelid and key_column.attnum = key_attnum.attnum
    where con.contype = 'f'
  ), catalog_rows as (
    select
      n.nspname as schema_name,
      c.relname as table_name,
      coalesce(
        array_agg(distinct lc.attname order by lc.attname)
          filter (where lc.attname is not null),
        array[]::name[]
      ) as columns,
      exists (select 1 from direct_refs dr where dr.relation_id = c.oid) as direct_reference,
      exists (
        select 1
        from pg_constraint child_fk
        where child_fk.contype = 'f'
          and child_fk.conrelid = c.oid
          and child_fk.confdeltype <> 'c'
          and child_fk.confrelid in (select relation_id from linked_tables)
      ) as non_cascading_reference
    from linked_tables linked
    join pg_class c on c.oid = linked.relation_id
    join pg_namespace n on n.oid = c.relnamespace
    left join linked_columns lc on lc.relation_id = c.oid
    group by n.nspname, c.relname, c.oid
  )
  select coalesce(json_agg(json_build_object(
    'table', schema_name || '.' || table_name,
    'columns', columns,
    'directReference', direct_reference,
    'nonCascadingReference', non_cascading_reference
  ) order by schema_name, table_name), '[]'::json)::text
  from catalog_rows;
`;

export function findAccountDeletionPolicyProblems(tables, policies) {
  const problems = [];
  const catalogNames = new Set(tables.map((table) => table.table));

  for (const table of tables) {
    const policy = policies[table.table];
    const requiresExplicitPolicy =
      table.directReference || table.nonCascadingReference;

    if (!policy) {
      if (requiresExplicitPolicy) {
        problems.push(`${table.table}: missing deletion policy`);
      }
      continue;
    }

    if (!["delete", "anonymize", "retain"].includes(policy.action)) {
      problems.push(`${table.table}: invalid action "${policy.action}"`);
    }

    if (policy.action === "retain") {
      if (!policy.legalBasis) {
        problems.push(`${table.table}: retained data needs a legalBasis`);
      }
      if (!policy.minimization) {
        problems.push(
          `${table.table}: retained data needs a minimization note`,
        );
      }
    }
  }

  for (const tableName of Object.keys(policies)) {
    if (!catalogNames.has(tableName)) {
      problems.push(`${tableName}: policy has no matching catalog table`);
    }
  }

  return problems;
}

function readCatalog() {
  const args = ["-X", "-A", "-t", "-q", "-c", CATALOG_QUERY];
  if (process.env.DATABASE_URL) args.push(process.env.DATABASE_URL);
  return JSON.parse(
    execFileSync("psql", args, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

function main() {
  const policies = JSON.parse(readFileSync(policyPath, "utf8"));
  const tables = readCatalog();
  const problems = findAccountDeletionPolicyProblems(tables, policies);

  if (problems.length) {
    console.error("Account deletion policy check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Account deletion policies cover ${tables.length} linked tables.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
