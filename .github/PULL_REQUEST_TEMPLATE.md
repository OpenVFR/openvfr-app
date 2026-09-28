## What / why

<!-- What changed and why. Link the issue if one exists. Factual, no filler. -->

## Checklist

- [ ] PR title follows Conventional Commits (`type(scope): summary`)
- [ ] Tests added/updated — **required** if this touches flight-critical math
      (fuel, W&B, TAS/wind triangle, magvar, geodesics, airspace containment)
- [ ] No third-party product/brand/site named as a design reference in code,
      comments, commit messages, or this description (`git grep` your diff)
- [ ] No personal or deployment-specific identifiers (domains, LAN IPs, local
      paths, emails, build-account names/IDs) and no references to private repos
- [ ] Docs / README / `.env.example` updated for any env var, config, or script change
- [ ] New dependency? License checked against `OSS-POLICY.md`
- [ ] New API endpoint? Auth + rate-limit stance stated (see `AGENTS.md`
      "Server API Security Baseline")
- [ ] UI change? Screenshot or recording attached (web and/or native)
