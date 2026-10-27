-- Minimal stand-ins for Supabase objects referenced by SQL snippets in docs/.
-- Loaded by scripts/run-doc-snippets.mjs inside a transaction that is always
-- rolled back. Keep this to the smallest surface the annotated snippets need.
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create table if not exists public.encounters (id uuid primary key, chief_complaint text);
