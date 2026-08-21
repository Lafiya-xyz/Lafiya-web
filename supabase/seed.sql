-- Local-dev-only fixture: one demo patient, for manually exercising the
-- profile editor, the public card page, and QR scanning against
-- `npm run dev` + `supabase start`. Runs on every `supabase db reset`.
-- Never applied against a hosted/production project.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, reauthentication_token
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'demo@lafiya.test',
  crypt('lafiya-demo-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now(),
  '', '', '', '', '', ''
);

-- Required alongside auth.users for GoTrue's email/password sign-in to
-- find the identity (this is what supabase.auth.signUp() creates for you
-- normally; we're inserting directly so this seed doesn't depend on
-- sending/confirming a real email).
insert into auth.identities (
  id, provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
values (
  gen_random_uuid(),
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '{"sub": "00000000-0000-0000-0000-000000000001", "email": "demo@lafiya.test", "email_verified": true, "phone_verified": false}',
  'email',
  now(),
  now(),
  now()
);

insert into public.profiles (
  user_id, card_public_id, name, date_of_birth, blood_group, genotype,
  allergies, medications, chronic_conditions, emergency_contacts, language
)
values (
  '00000000-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'Amina Yusuf',
  '1998-03-14',
  'O+',
  'AS',
  array['Penicillin'],
  array['Insulin'],
  array['Asthma'],
  '[{"name": "Halima Yusuf", "phone": "+2348012345678", "relationship": "Mother"}]'::jsonb,
  'Hausa'
);

insert into public.consent_events(user_id,purpose,purpose_version,action,idempotency_key)
select '00000000-0000-0000-0000-000000000001', purpose, 1, 'acknowledged', gen_random_uuid()
from (values ('emergency_public_disclosure'), ('offline_caching')) purposes(purpose);
