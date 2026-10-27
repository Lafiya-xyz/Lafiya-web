# Dependency and repository health

Issue #810. Vulnerability scanning (`npm audit`, Dependabot) catches known
CVEs; this process catches the project-health signals that tend to precede
supply-chain incidents: abandoned packages, single maintainers, and upstream
repositories without branch protection, signed releases, or pinned CI.

## OpenSSF Scorecard for this repository

`.github/workflows/scorecard.yml` runs on every push to `main`, weekly, and on
branch-protection changes. Results are:

- published to `api.securityscorecards.dev` (`publish_results: true`), which
  keeps the history used for trending and the public badge;
- uploaded as SARIF to GitHub code scanning (Security → Code scanning), where
  each failing check is tracked as an alert; and
- retained as the `scorecard-sarif` artifact for 90 days.

**Target score: ≥ 7.5.** Review the score at each release gate; a drop of more
than 0.5 or any new High-risk check failure must be triaged before release.

Actionable findings already addressed:

| Check | Remediation |
| --- | --- |
| Pinned-Dependencies | Every action is pinned to a commit SHA, enforced by `npm run ci:check-action-pins`. |
| Token-Permissions | Workflows default to `contents: read`; write scopes are granted per job (`supply-chain.yml`, `scorecard.yml`). |
| Dependency-Update-Tool | `.github/dependabot.yml` covers npm and GitHub Actions. |
| Branch-Protection | `main` requires a reviewed PR and passing CI, Supply chain, and Scorecard checks. Maintainers must keep these settings; Scorecard re-runs on `branch_protection_rule` events so a weakened rule is visible immediately. |

## Dependency health report

`npm run deps:health` inspects every direct production dependency in
`package.json` and flags any that:

- has an OpenSSF Scorecard score below `minScorecard` (or no result);
- has not published a release within `maxDaysSincePublish` days; or
- has fewer than `minMaintainers` npm maintainers.

Thresholds live in `security/dependency-health-allowlist.json`.

On every pull request, the **New dependency health summary** job in
`supply-chain.yml` runs the report against only the dependencies the PR adds,
writes it to the job summary, and posts (or updates) a PR comment. The job
fails when a new dependency is below threshold and not allowlisted.

## Adding a dependency below threshold

Add an exception to `security/dependency-health-allowlist.json` in the same PR:

```json
{
  "package": "example-lib",
  "reason": "No maintained alternative; used only for X; vendored fallback planned",
  "owner": "@github-handle",
  "reviewBy": "2027-04-01"
}
```

The allowlist is a reviewed file: changes require approval from a maintainer
other than the author. Exceptions past their `reviewBy` date are reviewed
quarterly alongside the full `npm run deps:health` report — renew with a fresh
justification, replace the package, or remove it.
