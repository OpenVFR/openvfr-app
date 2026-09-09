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

## Secrets

Never commit API keys, tokens, or credentials. This repo runs `gitleaks`
in pre-commit and CI — treat any flagged match as a hard stop, not a
warning. If you accidentally commit a secret, rotate it immediately and
open an issue — do not rely on a force-push/history rewrite alone, since
the secret may already be cached by forks/CI/search indexes.

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

## License of contributions

By submitting a pull request, you agree your contribution is licensed
under the project's [MIT License](./LICENSE).
