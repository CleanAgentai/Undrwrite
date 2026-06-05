# Vienna — Software Bill of Materials (SBOM)

Evidentiary attachment to `IP-SUBMISSION-ENGINEERING-AND-OSS.md`.

## Files
- **`vienna-sbom.json`** — machine-readable SBOM. For every one of the 217 resolved npm packages:
  `name`, `version`, SPDX `license`, `scope` (direct:runtime / direct:dev / transitive:runtime /
  transitive:dev), lockfile `path`, `resolved` URL, and `integrity` hash. Header block carries totals,
  the license histogram, and the copyleft/reciprocal scan result.
- **`vienna-licenses.csv`** — flat spreadsheet (name, version, license, scope, resolved) for counsel
  to sort/filter.

## Provenance & method
- **Source:** `package-lock.json` (lockfileVersion 3), which records an SPDX license identifier for
  every package in the resolved dependency graph.
- **Generated:** 2026-06-05, offline-reproducible (does not require an installed `node_modules`).
- **Root package:** `undrwrite-backend` is proprietary — declared `"license": "UNLICENSED"`,
  `"private": true`. It is the consumer, not a dependency, and is excluded from the package list.

## Headline results
- **217** resolved packages: 9 direct runtime + 1 direct dev + 207 transitive.
- License histogram: **175 MIT · 21 ISC · 11 Apache-2.0 · 4 BlueOak-1.0.0 · 2 BSD-3-Clause ·
  2 0BSD · 1 BSD-2-Clause · 1 (MIT AND Zlib)**.
- **Copyleft / reciprocal licenses: 0** (no GPL/AGPL/LGPL/SSPL/MPL/EUPL/CDDL/EPL/CPAL/OSL). All
  licenses are permissive or public-domain-equivalent.

## Recommended definitive export (when an environment with network access is available)
The lockfile-derived SBOM is authoritative for identifiers. To attach **full license texts and
copyright notices**, run against an installed dependency tree:
```
npm ci
npx license-checker --json --out sbom/vienna-license-checker.json
# optional SPDX/CycloneDX:
npx @cyclonedx/cyclonedx-npm --output-file sbom/vienna-cyclonedx.json
```
The package/version/license identifiers produced will match `vienna-sbom.json`.
