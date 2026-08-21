import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const directory = join(process.cwd(), "supabase", "migrations");
const failures = [];
for (const name of readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  const sql = readFileSync(join(directory, name), "utf8");
  const functions = sql.split(/create(?: or replace)? function/i).slice(1);
  for (const body of functions) {
    const header = body.slice(0, body.indexOf("$$"));
    if (
      /security definer/i.test(header) &&
      !/set search_path\s*=/i.test(header)
    )
      failures.push(
        `${name}: SECURITY DEFINER function without pinned search_path`,
      );
  }
  const tables = [
    ...sql.matchAll(/create table(?: if not exists)?\s+public\.([a-z0-9_]+)/gi),
  ].map((match) => match[1]);
  for (const table of tables)
    if (
      !new RegExp(
        `alter table public\\.${table} enable row level security`,
        "i",
      ).test(sql)
    )
      failures.push(
        `${name}: public.${table} does not enable RLS in its defining migration`,
      );
  const projections = [
    ...sql.matchAll(
      /function public\.get_emergency_card[\s\S]*?as\s+\$\$([\s\S]*?)\$\$/gi,
    ),
  ];
  if (projections.some((match) => /select\s+\*/i.test(match[1])))
    failures.push(`${name}: public emergency projection may not use SELECT *`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Migration security lint passed.");
