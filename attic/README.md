# attic/

Verified-dead files parked here during open-source release cleanup instead of
being deleted outright, so the removal stays reviewable. Every entry was
checked to have zero live references — no package.json script, CI workflow,
import, or doc points at it.

| File                                               | Original location          | Why it is dead                                                                                                          |
| -------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `api-streaming/`                                   | `test/api-streaming/`      | One-off provider streaming probe scripts (last touched 2025-11); never part of the vitest suite, referenced by nothing. |
| `file-refresh-checklist.md`                        | `test/manual/`             | Manual QA checklist for a per-dropdown refresh-icon UI that no longer exists in the codebase.                           |
| `scripts/desktop-package-targets.mjs` (+ `.d.mts`) | `scripts/`                 | Last production caller removed in 05988d4fd (2026-05-07); since then only its own test imported it.                     |
| `scripts/DesktopPackageVerifier.vitest.mts`        | `src/test-kernel/desktop/` | Tested only the dead `desktop-package-targets.mjs` above.                                                               |
| `scripts/check-cli-orchestration-manifest.mjs`     | `scripts/`                 | One-off consistency gate for a PRD handoff manifest that is complete; its tracking issue (#3838) closed 2026-05-12.     |

Delete this directory once a release cycle has passed without anything in it
being missed.
