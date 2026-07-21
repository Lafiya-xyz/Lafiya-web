# Visual Regression Testing

`e2e/visual-regression.spec.ts` snapshots the public card page for the
verified/not-verified badge states, in light and dark mode, at a mobile
(375×812) and desktop (1280×900) viewport — 8 baseline images total.

## Running locally

    supabase start
    npx playwright test visual-regression
    supabase stop

## When CI fails on a visual diff

CI fails when rendered pixels differ from the committed baseline in
`e2e/visual-regression.spec.ts-snapshots/`. Two possibilities:

1. **Unintended regression** — a CSS/layout change broke something. Fix the
   code, not the baseline.
2. **Intentional visual change** — you meant to change the design. Update
   the baselines locally and commit them as part of your PR:

       supabase start
       npx playwright test visual-regression --update-snapshots
       supabase stop
       git add e2e/visual-regression.spec.ts-snapshots
       git commit -m "chore: update visual baselines for <reason>"

Always call out baseline updates explicitly in the PR description so
reviewers know to actually look at the diffed images, not just approve
blindly.