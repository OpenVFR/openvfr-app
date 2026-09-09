# Third-Party Open Source Dependency Policy

## 1. Purpose

OpenVFR is released under the [MIT License](./LICENSE) — permissive and
freely redistributable. This policy governs which third-party open source
dependencies may be introduced, to keep the project's license terms clean,
avoid copyleft contamination, and preserve everyone's freedom to use,
modify, self-host, and redistribute this codebase.

## 2. Permitted licenses (compatible)

Freely usable, no special review needed:

* MIT License
* Apache License 2.0
* BSD 2-Clause and 3-Clause
* ISC License
* SIL Open Font License (OFL-1.1) — fonts, icons, typographic assets
* CC0 / Public Domain

## 3. Restricted licenses (strong copyleft)

**GPL (v2, v3), AGPL, SSPL** dependencies are not permitted in the core
application source. These licenses would force the entire combined work
under their terms, conflicting with OpenVFR's MIT license and restricting
downstream reuse. Tooling used only at build time (not linked/bundled into
the shipped app) may be reviewed case by case.

## 4. Conditional use (weak copyleft)

**LGPL, MPL, EPL** dependencies are permitted only if:

* Used exactly as packaged (e.g. via npm/NuGet), unmodified.
* Dynamically linked / used as a separate module at runtime — not
  statically embedded or forked into this repository.
* Clearly documented in `NOTICE` or equivalent attribution file.

## 5. Data licensing

This policy covers *code* dependencies. Aeronautical, weather, and
geographic *data* sources have their own licensing terms — see
[README.md § Data & attribution](./README.md#data--attribution). Data
licenses are reviewed independently of code licenses; a permissively
licensed data source is not automatically redistribution-safe (e.g.
CC-BY-NC data cannot be bundled with a commercial-adjacent product).

## 6. Review process

Before adding a new dependency, contributors should check its declared
license against sections 2–4 above. When in doubt, open an issue tagged
`license-review` before merging.
