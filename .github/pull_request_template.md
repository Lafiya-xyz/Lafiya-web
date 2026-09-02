## Description

Please include a summary of the changes, the problem solved, and any relevant context or issue references (e.g., Closes #123).

## Shared Contract Impact

Does this PR modify or touch a shared cross-repo contract?

- [ ] **No**
- [ ] **Yes**

If **Yes**, please check which contract(s) are affected and provide details on how the change is coordinated:

- [ ] **Attestation Schema** (effects on `lafiya-contracts`)
- [ ] **Emergency Data Model** (effects on `lafiya-docs`)
- [ ] **Environment/Config Keys** (effects on `.env.example`, stellar deployment keys, etc.)

_Details on coordination:_

## Verification Checklist

Please ensure all of the following checks pass locally before requesting review:

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` (unit/component tests) passes
- [ ] `npm run build` passes
- [ ] `npm run test:integration` passes (requires local `npx supabase start`)

## Additional Checklist

- [ ] New features include unit or component tests.
- [ ] Changes to RLS policies, RPCs, or Postgres schemas include integration tests.
- [ ] Database type definitions in `lib/supabase/types.ts` were hand-updated matching the migrations, using `type` aliases rather than `interface`s.
- [ ] Relevant documentation (README, config guides, etc.) has been updated.
