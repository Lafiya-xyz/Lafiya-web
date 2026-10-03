#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const run = (args, options = {}) => execFileSync('npx', ['supabase', ...args], {
  cwd: root,
  encoding: 'utf8',
  ...options,
});
const mode = process.argv.includes('--linked') ? '--linked' : '--local';

// Check the logical hand-authored contract first, then ask Supabase to diff the
// shadow/local database against the migration source of truth.
execFileSync('node', ['scripts/verify-supabase-types.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});
run(['db', 'diff', mode, '--schema', 'public'], { stdio: 'inherit' });
