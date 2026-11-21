-- Issue #936: FHIR Bulk Data ($export) job state.
--
-- One row per kick-off request. The worker (POST /api/internal/bulk-export)
-- claims queued rows with SKIP LOCKED, streams each resource type to NDJSON
-- in the private `bulk-exports` bucket in bounded pages, and records the
-- per-file checksums. The status endpoint mints 1-hour signed URLs from
-- `files` only for the partner that owns the job.
--
-- No PHI is stored here: only resource type names, object paths, byte sizes
-- and SHA-256 digests.

create table if not exists public.bulk_export_jobs (
  id uuid primary key default gen_random_uuid(),
  partner_id text not null,
  key_id uuid references public.partner_api_keys (id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  -- Requested FHIR resource types, already intersected with the key's scopes.
  resource_types text[] not null,
  -- FHIR _since / _typeFilter passthrough (opaque, validated by the route).
  since timestamptz,
  -- [{ type, path, bytes, sha256 }] once the worker finishes.
  files jsonb not null default '[]'::jsonb,
  error text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  -- Signed URLs are only issued while this is in the future (1 hour TTL).
  expires_at timestamptz not null default now() + interval '24 hours'
);

create index if not exists bulk_export_jobs_partner_idx
  on public.bulk_export_jobs (partner_id, requested_at desc);
create index if not exists bulk_export_jobs_queued_idx
  on public.bulk_export_jobs (requested_at)
  where status = 'queued';

alter table public.bulk_export_jobs enable row level security;
revoke all on public.bulk_export_jobs from anon, authenticated;

-- Private bucket for the NDJSON parts. Objects are only ever read through
-- short-lived signed URLs minted by the status endpoint.
insert into storage.buckets (id, name, public)
values ('bulk-exports', 'bulk-exports', false)
on conflict (id) do update set public = false;

-- Claims the oldest queued job for a worker. Returns null when the queue is
-- empty. SKIP LOCKED keeps concurrent workers from picking the same job.
create or replace function public.bulk_export_claim()
returns setof public.bulk_export_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.bulk_export_jobs j
     set status = 'running', started_at = now()
   where j.id = (
     select id from public.bulk_export_jobs
      where status = 'queued'
      order by requested_at
      for update skip locked
      limit 1
   )
  returning j.*;
end;
$$;

revoke all on function public.bulk_export_claim() from anon, authenticated;
