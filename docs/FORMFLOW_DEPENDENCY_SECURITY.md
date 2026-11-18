# FormFlow Dependency Security

Date: 2026-11-18  
Status: **FIXED AND VERIFIED** for production dependencies; **BLOCKED BY EXTERNAL DEPENDENCY** (no patched upstream version) for the four development-only advisories. **Not suppressed, not claimed clean.**

## Current audit results

| Command | Result |
|---|---|
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` (full) | **4 high**, 0 critical, 0 moderate, 0 low |

## Exact advisories and dependency paths

| Package | Version | Severity | Path | Advisory |
|---|---|---|---|---|
| `vite` | 6.4.6 | high (via dependent) | direct devDependency | transitive via `picomatch`; npm range `>=6.3.0-beta.0` |
| `tinyglobby` | 0.2.17 | high | `vite → tinyglobby → picomatch` | transitive |
| `fdir` | 6.5.0 | high | `vite → fdir → picomatch` (and `tinyglobby → fdir`) | transitive |
| `picomatch` | 4.0.7 | high | `vite → picomatch`, `vite → fdir → picomatch`, `vite → tinyglobby → picomatch` | **GHSA-fc5q-39xc-vjpf** — ReDoS through single-branch repeated extglobs, affects `<=4.0.7` |

## Investigation

- `picomatch` 4.0.7 is the **latest published version** (`npm view picomatch version`). There is no patched release; the advisory range covers all published versions.
- `fdir` 6.5.0 and `tinyglobby` 0.2.17 are latest; both require picomatch.
- `vite` 6.4.6 is the latest 6.x. npm suggests 6.2.7, a **downgrade** that drops the picomatch chain but also two minor releases of upstream fixes. Vite 7/8 are major upgrades that would violate the "avoid unrelated major upgrades / preserve the build system" constraint.
- All four packages are **development-only**. `npm ls` shows they are reachable only through `vite` and `@vitejs/plugin-react`. No application, extension, server or shared source file imports `picomatch`, `fdir` or `tinyglobby`.
- Production dependency audit remains clean; none of the affected code ships in `extension/dist` or the dashboard bundle (verified by the packaging script's forbidden-file and bundle-isolation checks).

## Vulnerable execution conditions

GHSA-fc5q-39xc-vjpf requires a **glob pattern containing a single branch with repeated extglobs** (e.g. nested `**/@(...)` groups) to be parsed by picomatch. In FormFlow this would require a developer-supplied Vite glob pattern. FormFlow's Vite config uses fixed, source-controlled patterns; user documents, profile values, vault content and remote messages never reach picomatch. There is no runtime path from web content to the affected code.

## Decision

No dependency version was changed. Rationale:

- No safe forward patch exists for picomatch; upgrading Vite would be an unrelated major change and downgrading loses fixes.
- The affected code is build-time only and not present in released artifacts.
- Changing the lockfile without a patched upstream package would not remove the advisory and could hide real issues.

The advisories are reported truthfully: the full audit is **not** zero-vulnerability.

## Compensating controls

1. Production dependency audit (`npm audit --omit=dev`) is part of CI and is clean.
2. Lockfile-based installs (`npm ci`) in CI; no floating dev dependencies.
3. Extension build isolation asserts no dev tooling enters bundles; packaging rejects `.ts`, `.map`, tests, source directories and test hooks.
4. Extension CSP allows only local scripts/workers and packaged WASM; no runtime eval or remote script loading.
5. User-controlled data never reaches glob parsing.

## Monitoring note (tracked)

Re-check `npm audit` whenever Vite is upgraded. Remove this note when **either**:

- `picomatch` publishes a version above 4.0.7 that resolves GHSA-fc5q-39xc-vjpf, or
- Vite moves to a release that no longer depends on `picomatch`/`tinyglobby`/`fdir`.

At that point update the smallest necessary dependency set, regenerate the lockfile, and re-run typecheck, tests, both builds and both audits. Do not suppress the advisory in the meantime.
