# Contributing to OpenVFR

Thanks for your interest in contributing. OpenVFR is MIT-licensed and open
to external contributions — this file covers the practical norms for
getting a change merged.

## Before you start

For anything beyond a small fix (new feature, refactor, new dependency),
open an issue first to discuss the approach. This avoids wasted work on a
PR that doesn't fit the project's direction.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`.
Scope is optional but encouraged for larger areas (`map`, `native`, `api`,
`shared`). Keep the summary under ~72 characters, imperative mood
("add", not "added"/"adds").

## Pull requests

- Keep PRs focused — one logical change per PR. Split unrelated fixes.
- Describe *what* changed and *why*, not just *what*. Link the issue if one
  exists.
- Keep tone factual and technical — no marketing language, no AI-generated
  filler. Reviewers need to evaluate the change quickly.
- Add/update tests for any behavior change, and screenshots/recordings for
  UI changes.
- Squash-merge is used by default — commit history within a PR doesn't need
  to be pristine, but the PR title becomes the squashed commit message, so
  make sure it follows the Conventional Commits format above.
- If you touched an env var, config default, script, or CLI flag, update
  every README / `docs/` mention and the matching `.env.example` in the
  same PR. Docs that describe removed behavior are treated as bugs.
- Fill in the PR template checklist — it mirrors the hard rules below.

## Flight-critical changes

Any pull request touching flight-critical calculations must include test
coverage before merge. This includes, but is not limited to:

- Fuel burn and range calculations
- Weight & balance
- True airspeed / wind triangle math
- Magnetic variation / declination models
- Great-circle and geodesic distance/bearing calculations
- Airspace intersection / containment logic

## Dependency licensing

Before adding a new dependency, check its license against
[OSS-POLICY.md](./OSS-POLICY.md). GPL/AGPL/SSPL dependencies are not
permitted in application code.

## Data licensing

Do not add datasets, sample flight plans, or navigation databases without
confirming their license permits redistribution in this repository (see
[README.md § Data & attribution](./README.md#data--attribution)). When in
doubt, ask before committing.

## Secrets & sensitive info

Never commit API keys, tokens, or credentials. This repo runs `gitleaks`
in pre-commit and CI — treat any flagged match as a hard stop, not a
warning. If you accidentally commit a secret, rotate it immediately and
open an issue — do not rely on a force-push/history rewrite alone, since
the secret may already be cached by forks/CI/search indexes.

This also covers non-secret personal/deployment-specific info that still
shouldn't be public: personal domains, LAN IPs, local file system paths,
personal email addresses, build-account names/IDs (Expo/EAS, Apple, Play),
or details tied to any one operator's own production infrastructure. This
repo describes a generic, self-hostable app (see
[`docs/self-hosting.md`](./docs/self-hosting.md)) — it should never
reference a specific real-world deployment. Account-specific build
identifiers go through environment variables (`apps/native/app.config.js`,
`.env.example`), never into `app.json` / `eas.json`.

Don't reference files or paths in private repositories either (the
maintainers' infra repo or your own) — public readers can't follow the
link. Put the relevant fact inline, or point at `docs/`.

Keep scratch notes, investigation logs, and AI-agent handoff documents out
of the tree — use the gitignored `.scratch/` directory. Anything worth
keeping becomes a `docs/` section or an `AGENTS.md` gotcha, reviewed like
code.

## No third-party product references in code/comments

Don't write comments, commit messages, or docs describing a technique or
UI pattern as "borrowed from," "matches," "X-style," or "inspired by" a
named third-party product, app, or website — even when the research was
done independently and in good faith. This covers more than competing
EFBs: weather sites, simulator-bridge tools, chart vendors, any brand used
as a comparison point. Don't reuse another product's feature name as the
name of ours, either. Describe *what* the code does and *why*, on its own
technical merits.

Naming something we actually *consume* (a data source, library, API,
protocol) is attribution, not comparison, and is fine — required, even,
for licensing.

This is a hard rule, not a style preference: it applies to AI-assisted
contributions too, where a model's training data or prior context can
easily surface a product name in an explanatory comment without the
contributor noticing. Before opening a PR, `git grep` your diff for brand
names.

## Code style

- TypeScript strict mode, no `any` without a comment explaining why.
- Follow the existing patterns in the file/module you're editing over
  introducing a new pattern, unless the PR's explicit purpose is a
  refactor.
- CSS Modules for component styles; no inline `style={{}}` except for
  genuinely dynamic computed values.
- See [`AGENTS.md`](./AGENTS.md) for hard constraints and gotchas, and [`docs/styling.md`](./docs/styling.md) for design-system/React conventions
  (map layer IDs, styling tokens, memoization rules, MapLibre gotchas,
  etc.) — these apply to human contributors too, not just AI agents.

## Reporting security or safety issues

Don't open public issues for vulnerabilities or safety-relevant data
defects — see [SECURITY.md](./SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

## License of contributions

By submitting a pull request, you agree your contribution is licensed
under the project's [MIT License](./LICENSE).
