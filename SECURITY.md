# Security Policy

OpenVFR is flight-planning software. Bugs in it can put a pilot in the air
with wrong information, so we treat safety-relevant defects (wrong airspace
boundaries, altitude/terrain miscalculations, stale NOTAM/weather shown as
current, route edits triggered by accidental touches, etc.) with the same
urgency as classic security vulnerabilities.

## Reporting

**Please do not open a public GitHub issue for security or safety reports.**

Use GitHub's private vulnerability reporting for this repository
("Security" tab → "Report a vulnerability"). Include:

- affected component (web / native / api / shared) and version or commit,
- reproduction steps or a proof of concept,
- impact as you understand it.

You'll get an acknowledgement within 7 days. We'll keep you informed as the
report is triaged and fixed, and credit you in the release notes unless you
prefer otherwise.

## Scope

- This repository: `apps/web`, `apps/native`, `apps/api`, `packages/shared`,
  `db/migrations`, `docker/`.
- Out of scope: third-party data sources (OFMX, OpenAIP, OSM, Open-Meteo,
  OpenSky, NMS-API…) — report data errors upstream — and any self-hosted
  instance run by someone else.

## Supported versions

Only the `main` branch and the latest published app-store / web release
receive fixes.
