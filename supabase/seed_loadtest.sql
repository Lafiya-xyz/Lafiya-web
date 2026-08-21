-- ---------------------------------------------------------------------------
-- Load-test seed: populates auth.users, auth.identities, and public.profiles
-- with NUM_PROFILES rows so the k6 harness has a realistic dataset.
--
-- Usage:
--   psql "$SUPABASE_DB_URL" -f supabase/seed_loadtest.sql
--
-- The script is idempotent against `supabase db reset` — reset wipes all
-- tables, so re-running is safe.  It intentionally does NOT conflict with
-- the demo row in seed.sql (user_id 00000000-…-000000000001).
--
-- Row count rationale: 500 profiles represents a realistic near-term pilot
-- deployment for a local health district.  This is large enough to
-- overwhelm ISR caching (revalidate = 60 s) when k6 fans requests across
-- distinct card IDs, while still fitting comfortably in a single-node
-- Supabase Postgres instance.
-- ---------------------------------------------------------------------------

-- Step 1: Seed auth.users — profiles.user_id has a NOT NULL FK to auth.users(id).
-- We generate deterministic UUIDs so the script is re-runnable and the IDs
-- are predictable for debugging.

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new,
  email_change, email_change_token_current, reauthentication_token
)
SELECT
  '00000000-0000-0000-0000-000000000000'::uuid,
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'loadtest-' || n || '@lafiya.test',
  -- Not a real password — these accounts are never signed into.
  crypt('loadtest-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now(),
  '', '', '', '', '', ''
FROM generate_series(1, 500) AS n
ON CONFLICT (id) DO NOTHING;

-- Step 2: Seed auth.identities — required for GoTrue to consider these
-- valid email/password accounts (mirrors what supabase.auth.signUp creates).

INSERT INTO auth.identities (
  id, provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  u.id::text,
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(),
  now(),
  now()
FROM auth.users u
WHERE u.email LIKE 'loadtest-%@lafiya.test'
ON CONFLICT DO NOTHING;

-- Step 3: Seed public.profiles with the correct column name (user_id, not id)
-- and distinct card_public_ids for the k6 script.

INSERT INTO public.profiles (
  user_id,
  card_public_id,
  name,
  date_of_birth,
  blood_group,
  genotype,
  allergies,
  medications,
  chronic_conditions,
  emergency_contacts,
  language
)
SELECT
  u.id,
  gen_random_uuid(),
  'Load Test User ' || row_number() OVER (ORDER BY u.id),
  '1990-01-01'::date + (random() * 10000)::int,
  (ARRAY['A+','A-','B+','B-','AB+','AB-','O+','O-','unknown']::public.blood_group_enum[])[
    floor(random() * 9 + 1)::int
  ],
  (ARRAY['AA','AS','SS','SC','AC','unknown']::public.genotype_enum[])[
    floor(random() * 6 + 1)::int
  ],
  CASE WHEN random() < 0.3 THEN ARRAY['Penicillin'] ELSE ARRAY[]::text[] END,
  CASE WHEN random() < 0.2 THEN ARRAY['Metformin'] ELSE ARRAY[]::text[] END,
  CASE WHEN random() < 0.15 THEN ARRAY['Asthma'] ELSE ARRAY[]::text[] END,
  '[]'::jsonb,
  (ARRAY['en','ha','yo','ig'])[floor(random() * 4 + 1)::int]
FROM auth.users u
WHERE u.email LIKE 'loadtest-%@lafiya.test'
ON CONFLICT (user_id) DO NOTHING;

-- Explicit legacy-equivalent consent keeps seeded cards queryable while
-- exercising the same consent gate as production cards.
INSERT INTO public.consent_events(user_id,purpose,purpose_version,action,idempotency_key)
SELECT u.id, 'emergency_public_disclosure', 1, 'acknowledged', gen_random_uuid()
FROM auth.users u WHERE u.email LIKE 'loadtest-%@lafiya.test';

-- Step 4: Export card IDs for the k6 script.
\copy (SELECT card_public_id FROM public.profiles WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'loadtest-%@lafiya.test')) TO 'loadtest/card_ids.txt';
