-- Issue #916: tenant-scoped org_admin console for CHW rosters, areas and
-- suspensions.
--
-- Creates:
--   public.chw_organizations        — tenant root (one row per CHW org)
--   public.chw_org_members          — roster: org_admin | chw membership
--   public.chw_org_invites          — expiring, single-use invite links
--   public.chw_org_areas            — LGA/ward or polygon service areas
--   public.chw_area_assignments     — CHW ↔ area, tenant-scoped
--   public.chw_org_audit_log        — append-only admin action trail
--   public.is_chw_org_admin()       — RLS helper (tenant scoping)
--   public.chw_org_roster()         — roster export projection
--   public.chw_org_invite_create()  — mint an expiring invite
--   public.chw_org_invite_accept()  — invite redemption
--   public.chw_org_area_assign()    — area assignment
--   public.chw_org_offboard_chw()   — offboarding: revoke attester rights,
--                                     release pending tasks, suspend identity
--
-- Cross-tenant isolation is enforced twice: every policy is scoped through
-- is_chw_org_admin(org_id) and every RPC re-checks the caller's membership
-- before touching a row. No PHI is stored here — roster metadata only.

create type public.chw_org_role as enum ('org_admin', 'chw');
create type public.chw_area_kind as enum ('lga_ward', 'polygon');

create table public.chw_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.chw_org_members (
  org_id uuid not null references public.chw_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.chw_org_role not null default 'chw',
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (org_id, user_id)
);
create index chw_org_members_user_idx on public.chw_org_members(user_id) where removed_at is null;

create table public.chw_org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.chw_organizations(id) on delete cascade,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  role public.chw_org_role not null default 'chw',
  invited_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chw_org_invites_expiry check (expires_at > created_at)
);
create index chw_org_invites_org_idx on public.chw_org_invites(org_id)
  where accepted_at is null and revoked_at is null;

create table public.chw_org_areas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.chw_organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  kind public.chw_area_kind not null,
  state_code text,
  lga text,
  ward text,
  -- GeoJSON Polygon/MultiPolygon, validated structurally (no PostGIS dep).
  polygon jsonb,
  created_at timestamptz not null default now(),
  constraint chw_org_areas_shape check (
    (kind = 'lga_ward' and lga is not null and polygon is null)
    or (kind = 'polygon' and polygon is not null and polygon->>'type' in ('Polygon', 'MultiPolygon'))
  )
);
create index chw_org_areas_org_idx on public.chw_org_areas(org_id);

create table public.chw_area_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.chw_organizations(id) on delete cascade,
  area_id uuid not null references public.chw_org_areas(id) on delete cascade,
  chw_id uuid not null references auth.users(id) on delete cascade,
  assigned_by uuid not null references auth.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (area_id, chw_id)
);
create index chw_area_assignments_chw_idx on public.chw_area_assignments(chw_id) where revoked_at is null;

create table public.chw_org_audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.chw_organizations(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (char_length(action) between 1 and 64),
  subject_id uuid,
  meta jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index chw_org_audit_log_org_idx on public.chw_org_audit_log(org_id, occurred_at desc);

alter table public.chw_organizations enable row level security;
alter table public.chw_org_members enable row level security;
alter table public.chw_org_invites enable row level security;
alter table public.chw_org_areas enable row level security;
alter table public.chw_area_assignments enable row level security;
alter table public.chw_org_audit_log enable row level security;

-- Tenant scoping helper. SECURITY DEFINER so policies can read membership
-- without recursing through chw_org_members' own RLS.
create or replace function public.is_chw_org_admin(p_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.chw_org_members m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.role = 'org_admin'
      and m.removed_at is null
  );
$$;
revoke all on function public.is_chw_org_admin(uuid) from public;
grant execute on function public.is_chw_org_admin(uuid) to authenticated;

create policy "chw_organizations_select_admin"
  on public.chw_organizations for select to authenticated
  using (public.is_chw_org_admin(id));

create policy "chw_org_members_select_admin"
  on public.chw_org_members for select to authenticated
  using (public.is_chw_org_admin(org_id) or user_id = auth.uid());

create policy "chw_org_invites_select_admin"
  on public.chw_org_invites for select to authenticated
  using (public.is_chw_org_admin(org_id));

create policy "chw_org_areas_select_member"
  on public.chw_org_areas for select to authenticated
  using (
    public.is_chw_org_admin(org_id)
    or exists (
      select 1 from public.chw_org_members m
      where m.org_id = chw_org_areas.org_id and m.user_id = auth.uid() and m.removed_at is null
    )
  );

create policy "chw_area_assignments_select_admin"
  on public.chw_area_assignments for select to authenticated
  using (public.is_chw_org_admin(org_id) or chw_id = auth.uid());

create policy "chw_org_audit_log_select_admin"
  on public.chw_org_audit_log for select to authenticated
  using (public.is_chw_org_admin(org_id));

-- All writes go through the SECURITY DEFINER RPCs below.
revoke all on public.chw_organizations, public.chw_org_members, public.chw_org_invites,
  public.chw_org_areas, public.chw_area_assignments, public.chw_org_audit_log
  from anon, authenticated;
grant select on public.chw_organizations, public.chw_org_members, public.chw_org_invites,
  public.chw_org_areas, public.chw_area_assignments, public.chw_org_audit_log
  to authenticated;
grant select, insert, update, delete on public.chw_organizations, public.chw_org_members,
  public.chw_org_invites, public.chw_org_areas, public.chw_area_assignments,
  public.chw_org_audit_log to service_role;

-- ---------------------------------------------------------------------------
-- RPC: chw_org_invite_create — mint an expiring, single-use invite link.
-- The caller supplies the SHA-256 digest of the token; the raw token never
-- reaches the database.
-- ---------------------------------------------------------------------------
create or replace function public.chw_org_invite_create(
  p_org_id uuid,
  p_token_digest text,
  p_role public.chw_org_role default 'chw',
  p_ttl_seconds integer default 604800
) returns public.chw_org_invites
language plpgsql security definer set search_path = '' as $$
declare v_invite public.chw_org_invites;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  if not public.is_chw_org_admin(p_org_id) then raise exception using errcode = '42501', message = 'ORG_NOT_AUTHORIZED'; end if;
  if p_token_digest !~ '^[0-9a-f]{64}$' then raise exception using errcode = '22023', message = 'INVALID_TOKEN_DIGEST'; end if;
  if p_ttl_seconds < 300 or p_ttl_seconds > 2592000 then raise exception using errcode = '22023', message = 'INVALID_INVITE_TTL'; end if;
  insert into public.chw_org_invites(org_id, token_digest, role, invited_by, expires_at)
    values(p_org_id, p_token_digest, p_role, auth.uid(), now() + make_interval(secs => p_ttl_seconds))
    returning * into v_invite;
  insert into public.chw_org_audit_log(org_id, actor_id, action, meta)
    values(p_org_id, auth.uid(), 'invite.created', jsonb_build_object('invite_id', v_invite.id, 'role', p_role));
  return v_invite;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: chw_org_invite_accept — redeem an invite for the calling user.
-- ---------------------------------------------------------------------------
create or replace function public.chw_org_invite_accept(p_token_digest text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_invite public.chw_org_invites;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  select * into v_invite from public.chw_org_invites where token_digest = p_token_digest for update;
  if not found then raise exception using errcode = 'P0002', message = 'INVITE_NOT_FOUND'; end if;
  if v_invite.revoked_at is not null then raise exception using errcode = '42501', message = 'INVITE_REVOKED'; end if;
  if v_invite.accepted_at is not null then raise exception using errcode = '23505', message = 'INVITE_ALREADY_USED'; end if;
  if v_invite.expires_at <= now() then raise exception using errcode = '40001', message = 'INVITE_EXPIRED'; end if;
  insert into public.chw_org_members(org_id, user_id, role)
    values(v_invite.org_id, auth.uid(), v_invite.role)
  on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null;
  update public.chw_org_invites set accepted_at = now(), accepted_by = auth.uid() where id = v_invite.id;
  insert into public.chw_org_audit_log(org_id, actor_id, action, subject_id, meta)
    values(v_invite.org_id, auth.uid(), 'invite.accepted', auth.uid(), jsonb_build_object('invite_id', v_invite.id));
  return v_invite.org_id;
end;
$$;
