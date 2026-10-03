# Record of Processing Activities (RoPA)

> **Generated file — do not edit by hand.**
> This document is produced by `scripts/generate-ropa.mjs`, which reads the
> `pg_description` metadata written by the `comment on table` / `comment on column`
> statements in `supabase/migrations/`. Regenerate it with:
>
> ```sh
> supabase db reset
> node scripts/generate-ropa.mjs
> ```
>
> CI fails when this committed copy is stale or when a PHI-bearing table has an
> unannotated column.

## Annotation convention

Table and column comments carry a JSON object describing the processing activity:

```sql
comment on column public.encounters.chief_complaint is
  '{"purpose":"emergency_care","basis":"consent","retention":"account_lifetime","recipients":["care_team"]}';
```

| Field        | Required | Description                                                        |
| ------------ | -------- | ------------------------------------------------------------------ |
| `purpose`    | yes      | Why the data is processed (e.g. `emergency_care`).                 |
| `basis`      | yes      | GDPR/NDPA legal basis (e.g. `consent`, `vital_interests`).         |
| `retention`  | yes      | Retention rule key (e.g. `account_lifetime`, `7_years`).           |
| `recipients` | no       | Array of recipient categories the data may be shared with.         |

A table is treated as **PHI-bearing** when its comment contains `"phi":true`.
Every column of a PHI-bearing table must carry a valid annotation, otherwise the
CI check fails.

## Processing activities

<!-- ROPA:TABLE_START -->

_No annotated tables found. Run `supabase db reset && node scripts/generate-ropa.mjs`
against a database with the compliance migrations applied to populate this section._

<!-- ROPA:TABLE_END -->
