-- Short-link prototype for QR payloads (issue #627, ADR-004).
--
-- Maps an opaque 11-character base62 code to a card_public_id.  The redirect
-- route (/r/<code>) reads this table and 302s to /card/<card_public_id>.
--
-- The short code maps to card_public_id (a non-secret public UUID), NOT to
-- a capability token.  Capability tokens retain their full length and bearer-
-- token security guarantee.  See docs/adr-004-short-link-domain.md.
--
-- Privacy: no PHI or capability tokens appear in this table.

create table public.short_links (
  code           text        primary key check (code ~ '^[A-Za-z0-9]{6,16}$'),
  card_public_id uuid        not null,
  created_at     timestamptz not null default now(),
  -- A profile may have at most one active short link at a time.
  constraint short_links_card_unique unique (card_public_id)
);

comment on table public.short_links is
  'Short-link prototype (issue #627). Maps base62 codes to card_public_ids. '
  'The redirect route (/r/<code>) reads this table with no-referrer policy.';

comment on column public.short_links.code is
  'Opaque 11-character base62 code (64-bit entropy). Never a capability token.';

-- Index for the redirect lookup (hot path, single-row read).
create index short_links_code_idx on public.short_links(code);

-- RLS: service role manages links; anon can look up (read-only) for redirect.
alter table public.short_links enable row level security;

grant select on public.short_links to anon, authenticated;
grant select, insert, update, delete on public.short_links to service_role;

create policy short_links_public_read on public.short_links
  for select to anon, authenticated using (true);
