# Directory organization before open-sourcing

Status: partially executed and reconciled with the current PR head.

Items **4-7** and **11** landed through PR #9537 (merge commit `44d5bbf05d`); items **2-3** and the
dependency-ownership half of item **10** landed through PR #9539 (merge commit `37dd55eebe`).
Items **1** and **15** landed through PR #9541. Items **8, 9, 12, and 13** landed in a follow-up
change on `claude/file-directory-organization-gafp4f`; item **14** was found already satisfied by an
unrelated prior commit. Completed rows remain below as an execution record, not future work. Item 10
is split into landed dependency ownership (10a) and remaining tsconfig/knip ownership (10b).

Executing item 7 confirmed a defect in its original blast-radius estimate: moving `texFormatter.ts`
also required rewriting its own formatter imports. Rows 8 and 9 and the §6 test-kernel checklist
have since been corrected for the same class of omission. Treat remaining blast-radius cells as
reviewed but not proven; only completed rows were exercised against the current PR-head tree.

Scope: directory and file placement across `src/`, `packages/`, `docs/`, and the
auxiliary root trees. Licensing, community-health files, and content accuracy are
tracked separately in `docs/proposals/2026-07-29-open-source-readiness.md` and
`docs/proposals/2026-08-01-open-source-readiness-audit.md` and are referenced, not
re-derived, here.

---

## 1. The shape of the problem

The first thing a stranger runs is `ls src/`, and the largest thing they still see is
`test-kernel/` — 875 tracked files, 224,343 LOC, 57.4% of everything under `src/` by
line count, sitting as a peer of `agent/`, `tools/`, and `shared/`, with a name that
describes neither tests nor a kernel (`src/test-kernel/support/` is now 28 tracked files).

The former indexing and written-rule defects are resolved. `src/README.md` now indexes all 19
production subsystems, bringing the tracked README count under `src/` from four to five. This PR also corrects the
`src/utils/` browser-reachability rule and the
`@common/errors`/`@utils/errors/errorMessage` split in `AGENTS.md`; moving `appendTail.ts` deleted
the separate `src/utils/strings/` directory, making the single-string-helper-home rule true.

What is _not_ wrong is most of the tree. Directory naming is uniform camelCase with
zero kebab or snake outliers across 161 distinct segments. Import discipline is
outstanding: aliases dominate imports and relative imports stop short of depth 4,
enforced by a custom auto-fixable `local/prefer-alias-for-deep-relative-imports`
rule. Path aliases are code-generated from one source (`tsconfig.json` →
`scripts/sync-tsconfig-paths.mjs`, CI-gated). `src/agent/core/`,
`src/agent/modelHandlers/`, `src/platform/`, `src/controllers/`, and
`packages/cli/src/` are genuinely well-decomposed. There is no dead-file
accumulation: across `src/utils/` + `src/common/` + `src/shared/` (249 TypeScript modules), not
one has zero production importers.

So the remaining problem is not broad structure. The live traps are narrower: files sitting beside
a directory of the same name (`src/tools/DelegationTools.ts` next to
`src/tools/delegation/`, `src/latex/latexdiff.ts` next to `src/latex/latexdiff/`),
`@common/*` resolving into two packages, 12 unfiled desktop cross-process contracts, and
trace-viewer's inherited path-map/knip ownership. The checkpoint clutter is gone: the proposal
directory now has 54 Markdown files, zero readiness checkpoints, and the 21 checkpoint files live
under `docs/dev/audits/`. Ten table items or sub-items are complete in this PR-head tree: eight via
merged prerequisites and two in this PR. The remaining work is items 8, 9, 10b, and 12-14, plus
the optional naming decisions — not a restructuring.

---

## 2. Do this

Ordered by value per unit of churn. Every blast-radius cell names the specific file
that breaks if you skip it.

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                | Blast radius (files that must change)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Effort |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | ✅ **Included in PR #9541: add `src/README.md`.**                                                                                                                                                                                                                                                                                                                                                   | The new index covers all 19 production subsystems, the browser-vs-node axis, the VS Code-free lint source, and the existing agent READMEs.                                                                                                                                                                                                                                                                                                         | No remaining action in this item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | done   |
| 2   | ✅ **Landed through PR #9539 (`37dd55eebe`): delete the `@types/*` alias and regenerate path maps.**                                                                                                                                                                                                                                                                                                | The reserved-scope collision is gone while `src/types/ambient.d.ts` remains included through tsconfig.                                                                                                                                                                                                                                                                                                                                             | No remaining action in this item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | done   |
| 3   | ✅ **Landed through PR #9539 (`37dd55eebe`): delete dead bare `@logger` and `@telemetry` aliases.**                                                                                                                                                                                                                                                                                                 | The nonexistent barrels are no longer advertised; live deep aliases remain.                                                                                                                                                                                                                                                                                                                                                                        | No remaining action in this item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | done   |
| 4   | ✅ **Landed through PR #9537 (`44d5bbf05d`): move `appendTail.ts` to `src/utils/text/`.**                                                                                                                                                                                                                                                                                                           | The documented single home for generic string helpers is now true.                                                                                                                                                                                                                                                                                                                                                                                 | Three imports and the alias comment were updated; old `src/utils/strings/` is gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | done   |
| 5   | ✅ **Landed through PR #9537 (`44d5bbf05d`): move `streamStatusTestUtils.ts` to `src/test-kernel/support/`.**                                                                                                                                                                                                                                                                                       | Shared test infrastructure now follows the documented promotion target.                                                                                                                                                                                                                                                                                                                                                                            | Sixteen imports were updated; support contains 28 tracked files at the current PR head.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | done   |
| 6   | ✅ **Landed through PR #9537 (`44d5bbf05d`): rename `src/shared/mainView/executeMessage.ts` to `executionFormState.ts`.**                                                                                                                                                                                                                                                                           | The duplicate-name/autocomplete trap is removed; the distinct wire schema at `src/shared/schemas/mainView/executeMessage.ts` keeps its existing name.                                                                                                                                                                                                                                                                                              | Two import sites were updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | done   |
| 7   | ✅ **Landed through PR #9537 (`44d5bbf05d`): move `texFormatter.ts` into `src/latex/formatter/`.**                                                                                                                                                                                                                                                                                                  | The beside-its-own-folder trap is removed.                                                                                                                                                                                                                                                                                                                                                                                                         | External importers and the moved file's own formatter-relative imports were updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | done   |
| 8   | ✅ **Done: moved the 10 delegation files at `src/tools/` root into the existing `src/tools/delegation/`** — `DelegationTools.ts`, `subagentResults.ts`, `subagentDiffs.ts`, `childStream.ts`, `childRunDelivery.ts`, `deliveryEnvelope.ts`, `delegationAgentAvailability.ts`, `delegationModelAvailability.ts`, `delegationWorktreeAvailability.ts`, `delegationDescriptionBlock.ts` (~1,915 lines) | This is an _active mis-navigation_, not untidiness: a reader looking for delegation code opens `src/tools/delegation/` (13 files) and never sees `DelegationTools.ts` one level up. Nothing in the tree tells them which is authoritative — there is no `src/tools/README.md` and CLAUDE.md is silent on `src/tools/` internals                                                                                                                    | All importers (alias- and relative-form, including `registry.ts`, `bash.ts`, `claudeAgent.ts`, `codex.ts`, `agentCliShared.ts`, and sibling files inside `delegation/` itself) were rewritten, plus the moved file's own now-same-directory relative imports. `src/test-kernel/architecture/toolRegistryCycle.vitest.ts:42`'s literal, `config/ratchets/shared-schemas-deep-import-baseline.json` (9 entries, resorted), and a `stateSettings.ts`/`tui-harness.tsx` doc-comment path landed in the same change. Confirmed unaffected as predicted: `architecture-edges-baseline.json`, `knip-baseline.json`, all 4 tsconfigs, `eslint.config.mjs:64`. Typecheck, lint, and the full `src/test-kernel/tools/`+`architecture/` suites are green                                                                                                         | done   |
| 9   | ✅ **Done: created `packages/desktop/src/shared/` and moved all 12 loose root files into it** — `desktopCommandSurface`, `desktopDiffMessages`, `desktopLogMessages`, `desktopOnboardingMessages`, `desktopPdfMessages`, `desktopPromptMessages`, `desktopProtocol`, `desktopShellMessages`, `desktopTaskShell`, `desktopWorkspaceMessages`, `hostBridgeChannels`, `workspacePath` — filenames kept | These 12 are the main↔preload↔renderer contract — verified by import tracing (`desktopShellMessages` pulled from both `main/` and `renderer/`; `hostBridgeChannels` from `main/` and `preload/`). Today `packages/desktop/src/` reads as "three process dirs and a pile", when the pile is the most architecturally important layer. A contributor adding an IPC message guesses `main/`, which quietly breaks the renderer's ability to import it | All import specifiers rewritten across `renderer/`, `main/`, `preload/`, `main/platform/`, and `test-kernel/desktop/`, correctly preserving the mixed module-resolution split (`.js`-suffixed relative imports in `main`/`preload`, extensionless in `renderer`/test-kernel, alias form in `main/platform/`). `config/ratchets/knip-baseline.json` and `shared-schemas-deep-import-baseline.json` entries were repointed and resorted; the three `DesktopControlSystem.vitest.mts` filesystem-read literals and one more `desktopCommandSurface.ts` doc-comment site (`extensionCommandHandlers.ts`) were updated in the same commit. `typecheck:desktop` (all 4 tsconfigs), the full `src/test-kernel/desktop/` suite (565 tests), and `check:dead-code-ratchet` are green                                                                           | done   |
| 10a | ✅ **Landed through PR #9539 (`37dd55eebe`): declare `zod` in `packages/trace-viewer`.**                                                                                                                                                                                                                                                                                                            | Runtime dependency ownership is now explicit and isolated installation no longer relies on the root store.                                                                                                                                                                                                                                                                                                                                         | Manifest and lockfile work is complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | done   |
| 10b | **Give trace-viewer explicit path-map and dead-code ownership.**                                                                                                                                                                                                                                                                                                                                    | It still extends `packages/desktop/tsconfig.paths.json` and has no `knip.json` workspace block. Because it genuinely consumes shared aliases, this requires a third generated derive target rather than simply deleting `extends`.                                                                                                                                                                                                                 | Update `scripts/aliasUtils.mjs`/`sync-tsconfig-paths.mjs`, trace-viewer tsconfig, `knip.json`, and any resulting ratchet baseline. Keep the `zod` change out of this remaining scope—it already landed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2-3 h  |
| 11  | ✅ **Landed through PR #9537 (`44d5bbf05d`): archive the agent-SDK checkpoint series under `docs/dev/audits/`.**                                                                                                                                                                                                                                                                                    | `docs/proposals/` now contains zero checkpoint files; all 21 checkpoints are in the archival directory.                                                                                                                                                                                                                                                                                                                                            | Relocation is complete. Optional future work is consolidation or an index, not another move.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | done   |
| 12  | ✅ **Done: folded the two doc singletons**: `docs/pocketflow/state_architecture.md` → `docs/architecture/pocketflow-state.md` (also fixed the only snake_case filename among 206 tracked docs markdown files); `docs/skills/skill-authoring.md` → `docs/dev/skill-authoring.md`                                                                                                                     | Both directories hold exactly one file and CLAUDE.md links into them, so they are load-bearing but read as abandoned                                                                                                                                                                                                                                                                                                                               | All 6 references updated: `CLAUDE.md:149`, `AGENTS.md:471` (gated by `scripts/check-guidance-refs.mjs`, which passes), `docs/README.md` (rewrote the two bullets rather than just repointing them, since both directories are gone), `docs/prds/cli-tui-ink/2026-05-14-30-reference.md:85`, and `docs/prds/2026-05-14-skills.md:25`. Dropped the now-empty `'pocketflow/**'` and `'skills/**'` entries from `publicDocs.js` `srcExclude`; `docs/scripts/check-root-docs.mjs` passes. **Caveat resolved**: the stale `runState.toSnapshot()` / `AgentRunState.fromSnapshot()` example was rewritten against the actual current API (`AgentRunStateSnapshot` is a plain Zod-validated object mutated by `recordCycleMetrics`/`recordRound`, not a class; only `AgentWorkspaceState` has real `toSnapshot()`/`fromSnapshot()`) before promoting the file | done   |
| 13  | ✅ **Done: `git mv packages/extension/src/MainViewProvider.ts packages/extension/src/webview/`** — the directory name stays                                                                                                                                                                                                                                                                         | `progressView/` and `settingsView/` each hold their `*ViewProvider.ts` _and_ their `*ViewMessageHandler.ts`; the main view alone has its provider orphaned at the package src root (only 3 `.ts` files live there) while its handler sits in `webview/`. This fixes the actual asymmetry                                                                                                                                                           | All 5 path rewrites landed: `packages/extension/src/commands.ts`, `progressView/ProgressViewProvider.ts`, the dynamic import in `src/test-kernel/webview/SidebarSurfaceOwnership.vitest.ts` (simplified to the `@webview/MainViewProvider` alias during lint --fix), the `shared-schemas-deep-import-baseline.json` entry (resorted — note the array is locale-sorted, not ASCII-sorted, so `frontend/…` sorts before `MainViewProvider.ts`), and `.claude/workflows/tech-debt-tournament.mjs`. Directory was **not** renamed, per §5 decision E. Sidebar suite, shared-schema ratchet, and full typecheck/lint are green                                                                                                                                                                                                                             | done   |
| 14  | ✅ **Already done before this survey**: `packages/agent/README.md` states it is the intended SDK surface, pre-release and unpublished, mirroring the disabled `publish-agent` job at `.github/workflows/release.yml:153-201`                                                                                                                                                                        | `packages/agent/src/` is 3 files / 510 lines with zero in-repo consumers, and its status is readable only from `if: ${{ false && … }}` at `release.yml:158`. A stranger reverse-engineers a disabled CI job to learn whether a package is real                                                                                                                                                                                                     | No action needed — the README already existed at survey time (landed via a prior, unrelated commit) with the exact framing this item asked for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | done   |
| 15  | ✅ **Included in PR #9541: add `skills/` and `prompts/` to guidance-reference prefixes.**                                                                                                                                                                                                                                                                                                           | Guidance citations into both shipped trees are now checked.                                                                                                                                                                                                                                                                                                                                                                                        | No remaining action in this item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | done   |

**Current tally:** items 1-9 and 11-15 are complete. Items 2-7, 10a, and 11 came through merged PRs
#9537/#9539; items 1 and 15 are part of PR #9541; items 8, 9, 12, and 13 landed in a follow-up change;
item 14 was already satisfied. The only remaining item is 10b.

---

## 3. Don't do this

Each of these was proposed and refuted. Recorded so nobody re-litigates them.

| Rejected                                                                                                                                    | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Split `src/agent/runtime/` (52 files, flat) into subdirectories**                                                                         | `src/agent/runtime/README.md` already contains a seven-row module map and a section literally titled **"Why this stays flat"** that makes and rejects this exact proposal, naming the condition to revisit ("if a future refactor touches a whole group's call sites anyway"). Cost is worse than the README estimates: **306 importer files and 664 distinct `@agent/runtime/*` specifiers**, plus 48 occurrences in `config/ratchets/host-agent-import-baseline.json` and 18 in `host-agent-mock-baseline.json`                                                                                                                                                                                                                     |
| **Move `src/tools/` external-agent (13 files) and filesystem (10 files) clusters into new subdirectories**                                  | These are the expensive two-thirds of the `src/tools/` proposal (~100 importer files) for materially less benefit than the delegation cluster. Neither sits beside a same-named directory, so neither causes the mis-navigation that justifies item 8. Revisit only if a refactor touches those call sites anyway                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Move all tools to `<domain>/<Name>Tool.ts` and fix `registry.ts`'s five import shapes**                                                   | After moving the 5 obvious candidates, `registry.ts` still imports in **four** shapes — 9 root-level `*Tool.ts`, 15 barrel-less domain dirs, 4 barrel imports all remain. Half-executing a consistency fix leaves the same confusion plus churned blame on `codex.ts` and `claudeAgent.ts`, two of the largest files in the subsystem. Also: the "primary export is the Tool class" premise is **false** for 3 of the 5 (`grep.ts` also exports `buildArguments`; `codex.ts` and `claudeAgent.ts` export `runStreamedTurn`). And it would require regenerating 8 entries in `config/ratchets/shared-schemas-deep-import-baseline.json`, which the original proposal missed. **Adopt the written rule (§4); drop the move**            |
| **Move `src/utils/errors/errorMessage.ts` to `@common/errors` or `@shared/`**                                                               | **199 import statements across ~200 files** — the most-imported leaf module in the repo — to empty one directory. Its current placement is _forced_ by `eslint.config.mjs:584-603`, which bars extension frontends from importing `@common` at runtime. Document the constraint (§4); leave the file                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Merge `src/utils/` into `src/common/`, or vice versa**                                                                                    | 51 of 56 `src/utils/` modules are not browser-reachable today, and all 28 `src/common/` modules are host-agnostic with mixed browser reachability; neither tree imports `vscode`. The `errors/`/`files/` name collisions between them are real but cause no reader harm — the alias prefix disambiguates at every call site. Fix the rule, not the tree                                                                                                                                                                                                                                                                                                                                                                               |
| **Regroup `src/shared/{wa,styles,litControllers,markdown,highlighting,monaco}/` under `src/shared/ui/`**                                    | **235 import statements**, plus **9 hardcoded literal source paths** in `src/test-kernel/settings/SettingsStyleContracts.vitest.mts:35,38,39,59,69,85,91` and `src/test-kernel/desktop/DesktopControlSystem.vitest.mts:42-43` that break silently. A README sentence makes the same boundary visible for free                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Move `src/shared/settingsView/handlers/` to `src/controllers/settingsView/`**                                                             | Refuted by an existing guard: `src/test-kernel/shared/SharedSettingsViewBoundary.vitest.ts:12` asserts nothing under `src/shared/settingsView` imports `@controllers/`, `@agent/`, `@model/`, `@tools/`, or `@auth/`. The placement is deliberate and enforced — these handlers live in `shared/` precisely because they must stay dependency-light, a strictly tighter constraint than `src/controllers/`, whose baseline out-edges include every subsystem the guard forbids. Moving them deletes the guard (and costs 31 statements across 21 files)                                                                                                                                                                               |
| **Fold the singleton subsystems `logger/`, `telemetry/`, `eventBus/`, `hosts/`, `replacement/`, `skills/`, `housekeeping/`, `transcript/`** | Every top-level `src/` directory is a **node** in `config/ratchets/architecture-edges-baseline.json` (96 edges, 18 nodes). Folding one rewrites the edge set and forces a baseline regeneration no reviewer can eyeball. `logger` is the extreme case: 12 in-edges, second-most-depended-on node in the graph — merging it into `utils` permanently erases the ratchet's ability to see who logs. All eight are coherently named and none is stale                                                                                                                                                                                                                                                                                    |
| **Move `src/types/ambient.d.ts`** (delete the alias only)                                                                                   | Referenced from **nine** places across four independently-resolving build graphs: `packages/desktop/tsconfig.{main,renderer,preload}.json`, `packages/trace-viewer/tsconfig.json:20`, `packages/extension/tsconfig.json:64`, `tsconfig.test-kernel.json:12`, `tsconfig.build.json:44`, plus the `turndown-plugin-gfm` special-case in three configs. Ambient declarations that fail to load degrade to `any` silently, and a single root `npm run typecheck` does not exercise the desktop preload or trace-viewer graphs                                                                                                                                                                                                             |
| **Rename `src/agent/index/` to `src/agent/catalog/`**                                                                                       | The confusion is real (`@agent/index` reads as "the agent barrel", which the repo bans), but: **90 occurrences across 75 files** (43 barrel + 32 deep imports like `@agent/index/agentRegistry` ×19), **three ratchets** carrying the literal string (`host-agent-import-baseline.json` 9, `host-agent-mock-baseline.json` 11, `shared-schemas-deep-import-baseline.json` 9), and ~20 ungated doc citations under `docs/prds/` and `docs/supabase/`. A one-line AGENTS.md entry (§4) captures most of the value for free. Rename _only_ if bundled into a pre-flip cleanup where blame churn is already being paid                                                                                                                    |
| **Rename `packages/extension/src/webview/` → `mainView/`**                                                                                  | Six hardcoded string sites, **two of which fail silently and ship**: `packages/extension/.vscodeignore:52` is `!src/webview/*.html`, the negation that re-includes the main view's HTML in the VSIX (skip it and the marketplace build has no main view); `scripts/verify-vsix-contents.mjs:184` asserts `extension/dist/webview/bundle.js`. Plus `packages/extension/vite.config.ts:7,41,44-45` (the string derives the **dist folder name**), `packages/extension/package.json:1813-1815` (three shell loops spelling `for v in progressView settingsView webview`), `MainViewProvider.ts:84,88,307`, `scripts/clean-extension-dist.mjs`, `common/webview/resourceRoots.ts:11-12`, `eslint.config.mjs:71,586`. Take item 13 instead |
| **Rename `packages/cli/src/chat/tui/` or `packages/cli/src/tui/`**                                                                          | The claimed "mechanical find-replace over relative paths" is false — **zero** files under `chat/tui/` use a relative path to the primitives; all 133 occurrences across 57 files are the alias form `@cli/tui/…`. And `packages/cli/scripts/reactCompilerPlugin.mjs:20-26` hardcodes `TUI_PATH_SEGMENTS`, with a comment at `:5-9` warning that these components "silently lose compiler memoization on relocation". No call site is ambiguous today                                                                                                                                                                                                                                                                                  |
| **Move the 23 package-specific files out of root `scripts/`**                                                                               | `knip.json:7` makes `scripts/**/*.mjs` an **entry of the root workspace**; neither `packages/extension` (`src/**/*.{ts,tsx}`) nor `packages/desktop` includes `scripts/`. The move silently drops 23 scripts out of `npm run check:dead-code-ratchet`. Also `packages/extension/.vscodeignore` has no `scripts/**` or blanket `*.mjs` rule, so a new `packages/extension/scripts/` ships into the VSIX by default. The filenames already carry ownership (`verify-desktop-package.mjs`, `copy-extension-skills.mjs`)                                                                                                                                                                                                                  |
| **Move `packages/extension/resources/` to the repo root**                                                                                   | It is already the staging **destination** for root-level shared assets: `scripts/copy-extension-skills.mjs:11-21` copies root `skills/` _into_ it, gitignored per `packages/extension/.gitignore:9-11`. Inverting the flow for a sibling subtree creates two opposite conventions in one directory. It also breaks zero-build dev access — `packages/extension/src/extension.ts:199,288` and 3 other sites read resources straight out of the tree via `context.extensionPath`, which in F5 dev _is_ `packages/extension/`                                                                                                                                                                                                            |
| **Rename `packages/extension/src/frontend/`** (the misleading extension-host tree)                                                          | Already documented deliberately: `AGENTS.md:94-101` gives it a seven-entry subdirectory map and a usage rule; `CLAUDE.md:64-68` disambiguates it explicitly. And the proposal defeats itself — the word `frontend` appears in **203 import specifiers across 86 files**, so leaving the alias leaves the confusion verbatim in every import line. Keep the three-column mapping table idea (§4)                                                                                                                                                                                                                                                                                                                                       |
| **Move `docs/` into the pnpm workspace**                                                                                                    | The isolation is deliberate and documented: `docs/scripts/check-root-docs.mjs:11-12` says it is "intentionally dependency-free … so it runs without installing the docs sub-project", repeated at `docs/.vitepress/publicDocs.js:5-7`. Folding it in pushes vitepress + mermaid into every contributor's install. One sentence in `docs/README.md` fixes the real defect                                                                                                                                                                                                                                                                                                                                                              |
| **Restructure `docs/` into `public/` + `internal/`**                                                                                        | Moving `docs/dev/` makes `scripts/check-guidance-refs.mjs:27` `GUIDANCE_DIRS` point at a nonexistent path — **the gate stops scanning and starts passing silently**, same for `ARCHIVAL_DIRS:32`. ~190 citations would need rewriting, of which only ~6 are inside any gate's scan set. The safety property this is meant to buy already exists: `check-root-docs.mjs:62-92` hard-fails any root entry classified in neither the allowlist nor `srcExclude`                                                                                                                                                                                                                                                                           |
| **Split the remaining `docs/proposals/` into `active/` / `shipped/` / `archive/`**                                                          | Merged PR #9537 archived all 21 checkpoints; the directory now contains 54 Markdown files. A further split still requires human classification and rewrites many ungated citations, including source comments. Item 11 in merged PR #9537 already delivered the low-risk reader benefit; reconsider only with a dedicated citation migration.                                                                                                                                                                                                                                                                                                                                                                                         |
| **Subdivide `docs/.vitepress/components/` (104 flat `.vue` files)**                                                                         | ~147 import rewrites (88 markdown + 59 inter-component) plus 23 registrations in `theme/index.js`, every one a **silent runtime break** — Vue SFC imports in markdown are not type-checked and there is no docs typecheck step. The files already self-organize by suffix (`*Hero.vue`, `Mockup*.vue`, `*Card.vue`). No stranger reads the marketing site's Vue internals                                                                                                                                                                                                                                                                                                                                                             |
| **Reorganize `docs/supabase/` or promote its SQL into `supabase/migrations/`**                                                              | `docs/README.md` states an explicit conditioned hold ("remains here until an approved private destination has been created, copied, hash-verified, access-checked, and tested"). And four of the 13 files are factually wrong per `2026-08-01-open-source-readiness-audit.md` §4.5 — promoting stale SQL into the location a Supabase CLI user trusts is actively harmful. The one real item (`remote-agents.config.json` is a runtime input under `docs/`) is a two-line change to `scripts/sync-remote-agents.mjs:23-24`                                                                                                                                                                                                            |
| **Rename `@texra/desktop` and `@texra/trace-viewer` to `@texra-ai/*`**                                                                      | `"private": true` is already the machine-readable, npm-native signal for "never published" and it is already correct on both. The rename touches ~14 references across 8 files including a real dependency edge at `packages/extension/package.json:1769`. Document the rule instead (§5, decision A)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Split `src/test-kernel/cli/` (147 flat files) to mirror `packages/cli/src/`**                                                             | Suites are leaves — nothing imports them, `vitest.config.mjs:26`'s `**` glob is depth-agnostic, and nobody navigates to a test by walking the tree. Cost: `config/ratchets/host-agent-mock-baseline.json` pins 40 exact paths under `src/test-kernel/{cli,desktop}` and `hostAgentMockRatchet.vitest.ts:48-50` resolves those directories by literal name; `agentRuntimeProgressEventsBoundary.vitest.ts:36-39` pins 3 more. A second ~200-file relocation immediately after item 18 invalidates every open branch twice                                                                                                                                                                                                              |
| **Move `packages/desktop/tests/e2e/` or delete its screenshot baselines**                                                                   | `packages/desktop/tests/e2e/README.md` already states the suite is "**not** wired into the default `npm test` flow" and documents the manual `TEXRA_UPDATE_E2E_SCREENSHOTS=1` baseline workflow, explaining the PNGs are committed "so reviewers have a fixed reference". The layout is idiomatic Playwright. Baseline staleness is a test-maintenance question, not a directory one                                                                                                                                                                                                                                                                                                                                                  |
| **Delete the four `src/tools/*/index.ts` barrels**                                                                                          | The consumer counts behind this were wrong: `src/tools/inquiry/index.ts` has 3 consumers, not 6 — the other four resolve to `src/shared/schemas/inquiry.ts`, an unrelated module, and those four files appeared in the proposed edit list. `src/tools/setup/index.ts` and `src/tools/approval/index.ts` already carry the docstring the rule requires. Adding a docstring to `lean/`, `latex/`, and `userQuestion/` satisfies AGENTS.md's "documented public surface" carve-out for 3 lines                                                                                                                                                                                                                                           |
| **Delete `docs/proposals/2026-07-17-workflow-script-async-execution.md.local-before-pull`** as a merge artifact                             | It is not one. Lines 3-7 read: "**Historical snapshot (not authoritative).** This file preserves the local-before-pull state of the proposal. Refer to the [canonical proposal](…) for the current, authoritative version." Deleting it is free, but it is a deliberate, self-labeling, cross-linked archive — a judgment call for the maintainer, not a defect                                                                                                                                                                                                                                                                                                                                                                       |
| **Move `TERMS_OF_SERVICE.md` into `docs/`**                                                                                                 | `docs/scripts/check-root-docs.mjs:78-81` hard-fails any root `.md` in neither `publicRootDocs` nor `srcExclude`, and `docs/package.json:5` `sync-legal` (`cp ../TERMS_OF_SERVICE.md terms.md`) becomes a same-directory self-copy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Change `packages/trace-viewer`'s `outDir`** away from `../extension/resources/traceViewer` (yet)                                          | Touches `vite.config.ts:16-19`, `vite.standalone.config.ts:27`, `packages/extension/.gitignore:16-21`, `.vscodeignore:34-49`, `packages/cli/scripts/copy-resources.mjs:33`, `electron-builder.yml:44`, `scripts/verify-desktop-package.mjs:631`, `src/transcript/standaloneTraceHtml.ts:35`, `src/controllers/settingsView/ChatExportController.ts:177` — **plus a new extension copy step that does not exist today**. Do the declaration fixes (item 10); defer this                                                                                                                                                                                                                                                                |
| **Write `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` now**                                                                                      | Already decided: `2026-08-01-open-source-readiness-audit.md` §6 lists these under "explicitly not worth doing" and `2026-07-29-open-source-readiness.md` explains the reasoning — soliciting contributions under all-rights-reserved with no CLA creates IP ambiguity. They are held behind the license decision, not overlooked. Same for `.github/ISSUE_TEMPLATE/`: `README.md:142` routes issues to `github.com/texra-ai/texra-issues` deliberately                                                                                                                                                                                                                                                                                |
| **Create `packages/README.md`**                                                                                                             | It would duplicate `AGENTS.md:85-92` while falling **outside** `scripts/check-guidance-refs.mjs` (`:26-27` = CLAUDE.md, AGENTS.md, `.claude/skills`, `docs/dev`), the gate built precisely because guidance prose rots. Two indexes, one guarded and one not, is worse than one guarded index — and the rot rate is not hypothetical: a proposed test-kernel map in this very survey listed a `settingsView/` directory that does not exist (the real one is `settings/`). **Extend AGENTS.md:85-92 instead**                                                                                                                                                                                                                         |

---

## 4. Document instead of moving

This is where most of the value is. All of these are placement questions whose real
fix is prose in a **gated** file — `CLAUDE.md`, `AGENTS.md`, `.claude/skills/**`, or
`docs/dev/**`, the four locations `scripts/check-guidance-refs.mjs:26-27` scans.
Everything else rots unwatched.

### 4.1 Correct the `src/utils/` rule — only 5 of 56 modules are browser-reachable

Replace `AGENTS.md:106` and the corresponding `CLAUDE.md` "Layout" bullet.

> `src/utils/` holds host-agnostic, `vscode`-free helpers reached by agnostic core.
> Only a small browser-safe subset is additionally importable by webviews — today
> `@utils/core`, `@utils/core/boundedIdSet`, `@utils/text/stringUtils`,
> `@utils/errors/errorMessage`, and `@utils/files/pastedImageName`. The other 51 modules are not currently
> browser-reachable and must not be assumed browser-safe; 22 of all 56 import
> `node:` builtins outright.

Evidence: measured across all 216 browser-side source files in
`packages/extension/src/{webview,progressView,settingsView}/frontend`,
`packages/desktop/src/renderer`, and `packages/trace-viewer/src`, exactly 5 distinct
`@utils/*` module paths are reachable. Zero files under `src/utils/` import `vscode`
— which also means **`CLAUDE.md`'s VS Code-allowed-zone list is wrong in the other
direction**: it names `src/utils/config/`, whose 5 files contain no `vscode` import.
Fix both.

### 4.2 State the `utils/` vs `common/` vs `shared/` axis

Add to `src/README.md` and `AGENTS.md:102-106`:

> The axis is reachability, not host. `src/shared/` is everything reachable from a
> **browser** context (93 of 165 files are). `src/utils/` and `src/common/` are host-agnostic but have mixed browser reachability;
> the line between them is genericity —
> `src/utils/` holds domain-free primitives (strings, paths, fs wrappers, exec, git);
> `src/common/` holds TeXRA-domain host-neutral logic (error taxonomy, team roster,
> storage layout). `errors/` and `files/` exist under both by design; the alias
> prefix disambiguates at every call site.

Note the existing `AGENTS.md:102` phrase "backend-only helpers" for `src/common/` is
slightly wrong — `src/shared/subagentFollowup.ts:20` imports
`@common/parsing/safeParseJson`, so reach into the browser-adjacent tree is nonzero.

### 4.3 Correct the `src/shared/` description

`CLAUDE.md` calls it "wire contracts and UI-shared message types". Actual contents
include 26 files importing `lit` (11 in `wa/`, 10 in `styles/`, 3 in
`litControllers/`, plus `utils/dom.ts` and `BaseWebviewApp.ts`), a markdown-it+KaTeX
pipeline (`markdown/`, 5), and a Monaco shim. Replace with:

> `src/shared/` is everything reachable from a browser context — wire contracts
> (`schemas/` 62, `ipc.ts`, `hostBridgeTypes.ts`, `streams/`, `commands/`, `state/`)
> **plus the shared webview UI kit** (`wa/` 16, `utils/` 12, `styles/` 11,
> `copy/` 6, `markdown/` 5, `litControllers/` 4, `highlighting/` 3, `monaco/` 1).
> The "no `@agent/*` imports here" rule follows from the contracts half.

This also makes the no-`@agent` rule read as a consequence rather than an arbitrary
constraint.

### 4.4 Document the error-helper split — the single highest-frequency placement decision

`AGENTS.md:131` says "Surface errors once through the shared error utilities in
`@common/errors`". But `@utils/errors/errorMessage` has ~199 importers, more than
double `@common/errors`' ~95. Add under `### Directory organization`:

> `@common/errors/` is the backend-only error surface — SDK error classification,
> provider formatting, agent error classes. `@utils/errors/errorMessage` is the
> browser-safe error-to-string primitive and lives outside `@common/` deliberately:
> `eslint.config.mjs:584-603` bars **extension frontends** from importing `@common`
> or `@tools` runtime values (type imports are allowed). Note that rule covers
> `packages/extension/src/{webview,progressView,settingsView}/frontend/**` only —
> it does **not** cover `packages/desktop/src/renderer/**` or
> `packages/trace-viewer/src/**`, where the same invariant is convention, not lint.
> **The test: if a webview needs it, it cannot live in `@common/`.**

Write the scope caveat exactly. A confidently-wrong claim here is worse than none —
`check-guidance-refs.mjs` verifies only that cited _paths_ exist, never that the
surrounding claim is true (it says so at `:14-16`).

### 4.5 Write down the filename rule that already governs 90% of the tree

Add under `AGENTS.md`'s `### Naming conventions` (lines 79-84), which currently
covers only const-object casing and `UPPER_SNAKE_CASE`:

> Filenames are camelCase. PascalCase only when the module's identity is **one
> primary exported symbol** — a class, a Lit/Ink component, or a single dominant
> type — in which case the filename matches that symbol exactly. Directories are
> lowercase or camelCase, never kebab or snake; packages are the exception
> (`trace-viewer`).

Measured: 1,143 camelCase / 386 PascalCase / **0 kebab / 0 snake** across
non-test source files. Of 211 PascalCase files under `src/` (excluding test-kernel),
64 export no class — all type-identity modules (`IModelHandler.ts`,
`ConversationBlockTypes.ts`, `AgentFinalResult.ts`), which the "primary exported
symbol" wording covers. **Rename nothing**: 64 renames break git blame for zero
reader benefit, and the rule as worded makes 211 of 211 compliant by definition.

Skip the optional `unicorn/filename-case` lint. Configured to allow both camelCase
and PascalCase (the only configuration that passes today) it would happily accept a
new PascalCase file exporting a plain function — the exact deviation the rule
prevents — while locking out kebab and snake, which nothing uses.

### 4.6 Write down the `src/tools/` placement rule

There is no `src/tools/README.md` and CLAUDE.md is silent on the subsystem's
internals, yet `registry.ts:12-70` teaches five import shapes at once. New tools are
the most likely first contribution from an outside contributor. Add to
`AGENTS.md`'s `### Directory organization`:

> New tools go in a domain subdirectory as `<Name>Tool.ts`, imported directly by
> `src/tools/registry.ts`. Do not add a barrel; the 8 existing ones
> (`approval`, `github`, `goal`, `inquiry`, `latex`, `lean`, `setup`,
> `userQuestion`) predate the rule and each must carry a docstring declaring its
> surface. Files at the `src/tools/` root are legacy placement, not a second
> sanctioned option.

### 4.7 Name `src/agent/index/` for what it is

One line, in `src/README.md` and `AGENTS.md`:

> `src/agent/index/` is the **agent catalog** — registry, agent directories, YAML
> scanning, remote agent metadata. The directory name predates the barrel
> convention and is not a barrel; `@agent/index` is a subsystem path, not
> `@agent`'s public surface.

### 4.8 Add the three-column host-layer mapping to `AGENTS.md:85-92`

The same internal layer is named three different things across hosts, and this is
genuinely non-obvious:

| Concern                   | extension                                                                  | desktop                                       | cli                                                                           |
| ------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| Host-side service helpers | `packages/extension/src/frontend/` (7 subdirs, mapped at AGENTS.md:94-101) | `packages/desktop/src/main/`                  | `packages/cli/src/runtime/`                                                   |
| Cross-process contracts   | root `src/shared/`                                                         | `packages/desktop/src/shared/` (after item 9) | root `src/shared/`                                                            |
| UI                        | `src/{webview,progressView,settingsView}/frontend/`                        | `packages/desktop/src/renderer/`              | `packages/cli/src/chat/tui/` (app) + `packages/cli/src/tui/` (Ink primitives) |

Also state the workspace index here (five packages, name, published-to) rather than
in a new `packages/README.md` — see §3.

### 4.9 Add a `docs/README.md` sentence on the docs sub-project's isolation

> `docs/` is deliberately **not** a pnpm workspace member. It carries its own
> `package-lock.json` and installs with `cd docs && npm ci` so the VitePress site
> builds without the monorepo toolchain, and so the commit-time gates
> (`docs/scripts/check-root-docs.mjs`, `docs/.vitepress/publicDocs.js`) stay
> dependency-free.

Optionally add `docs:dev` / `docs:build` passthroughs to root `package.json` (49
scripts today, none for docs).

### 4.10 Three new READMEs that replace physical merges

| File                                     | Content                                                                                                                                                                                                                                                                                                                                                                                               | Replaces                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/extension/resources/README.md` | `agents/` = reflection-flow YAML; `tool_use_agents/` = tooluse-flow YAML; both packaged into the VSIX                                                                                                                                                                                                                                                                                                 | Merging the four agent-YAML trees. Note `prompts/README.md:7-20` already enumerates all four homes — what is missing is only the **flow** mapping, which is one sentence there and one in CLAUDE.md's Agent system paragraph (which today names only `resources/agents/`, 5 of 57+ agent YAML, and never mentions `tool_use_agents/`)                        |
| `skills/README.md`                       | The uniform package shape (`SKILL.md` + `references/*.md` + `agents/openai.yaml`, all 14 identical), **both packaging consumers by path** — `scripts/copy-extension-skills.mjs:12-21` and `packages/desktop/electron-builder.yml:48-49` — and a pointer to the authoring rules                                                                                                                        | Moving `skills/`, which those two hardcoded manifest paths make load-bearing at the root                                                                                                                                                                                                                                                                     |
| `config/README.md`                       | These are **generated, checked-in** baselines with two consumer families (4 Vitest architecture tests and `scripts/check-dead-code-ratchet.mjs`), plus how to regenerate each — especially `architecture-edges-baseline.json`, whose 96 pinned edges make every top-level `src/` rename expensive. Nothing currently says this at the file's own location; a contributor discovers it from a red test | Moving `config/ratchets/` into `src/test-kernel/`, which would hide it from `check-dead-code-ratchet.mjs`. Also record: **do not** move root tool configs into `config/` — `eslint.config.mjs`, `tsconfig.json`, `.prettierrc`, `.pre-commit-config.yaml`, `pnpm-workspace.yaml`, `package.json` are all root-discovered by convention or editor integration |

### 4.11 Add the test-placement mapping to `AGENTS.md` (currently one line, at `:124`)

> All Vitest suites live under `src/test-kernel/`; **zero** are colocated (verified
> across `src/**` and `packages/*/src/**`). The directory is the source subsystem,
> with two aliases that cannot be derived: `packages/extension/src/settingsView/` →
> `test-kernel/settings/`, and `packages/<pkg>/src/` → `test-kernel/<pkg>/`. Suites
> mirror the source tree only where a subsystem has earned subdirectories; flat is
> fine. Shared fakes are promoted to `src/test-kernel/support/` (fixture rule of
> three, one fake per port).

Do **not** write a `.ts` vs `.mts` rule until it is verified. The plausible rule
("`.mts` when the suite transitively imports an ESM-only dependency") is refuted by
`src/test-kernel/cli/`, which holds 4 `.ts` files among 143 `.mts`. Derive the real
constraint from `tsconfig.test-kernel.json` first, or document only the part that is
observably true (PascalCase-after-subject).

### 4.12 A lint rule worth adding

When item 10b or the `@traceViewer/*` alias lands, add `'@traceViewer/**'` to
`eslint.config.mjs:90-105` `HOST_LAYER_RESTRICTED_IMPORT_PATTERNS`, beside the
existing `'@cli/**'` and `'@desktop/**'` at `:102-103`. Without it, root `src/`
production code gains a lint-legal import path into a host UI package — the exact
boundary that rule block exists to hold. This is the one alias addition with a real
failure mode.

Also consider hardening `docs/scripts/check-root-docs.mjs`: extend `TIMESTAMPED_DIRS`
(`:26`) or add a plain kebab-case filename check to cover `architecture/`, `design/`,
and `reference/`, which today have no naming gate at all — which is how
`docs/prds/2025-12-25-POCKETFLOW_ISSUES_PROGRESS.md` and
`docs/prds/2026-01-03-LOGGING_STREAMING_ARCHITECTURE.md`, the only two
SCREAMING_SNAKE files under `prds/`, got in.

---

## 5. The naming decisions

One-way doors. Once the repo is public and people import from it, each of these is
expensive to revisit.

### A. Package scopes — **keep all three, document the rule**

| Package dir             | npm name                       | Published to                              |
| ----------------------- | ------------------------------ | ----------------------------------------- |
| `packages/extension`    | `texra` (publisher `texra-ai`) | VS Code Marketplace as `texra-ai.texra`   |
| `packages/cli`          | `@texra-ai/cli`                | npm (`release.yml:144`)                   |
| `packages/agent`        | `@texra-ai/agent`              | npm — **job disabled**, `release.yml:158` |
| `packages/desktop`      | `@texra/desktop`               | never (`private: true`)                   |
| `packages/trace-viewer` | `@texra/trace-viewer`          | never (`private: true`)                   |

**Recommendation:** state the rule in `AGENTS.md:85-92` — `@texra-ai/*` = published
to npm; `@texra/*` = workspace-internal, never published; bare `texra` = VS Code
Marketplace identity, which cannot be scoped. Do not rename. `"private": true` is
already the machine-readable signal a stranger checks before any prose convention,
and it is already correct on both `@texra/*` packages. **Open question for the
maintainer:** is the `@texra` npm scope actually owned? `release.yml` only ever
publishes `@texra-ai/*`. If it is not owned, squatting an unowned scope in two
manifests is worth a one-line comment even if the names stay.

### B. `@common/*` resolving into two packages — **rename, but not urgently**

`tsconfig.json` declares `@common/state` and `@common/webview` →
`packages/extension/src/common/*` while `@common/*` → `src/common/*`. So
`import … from '@common/webview'` and `import … from '@common/errors'` in the same
file resolve into different packages, one VS Code-coupled and one in a VS Code-free
zone. The repo has already paid for this twice in documentation
(`CLAUDE.md`'s defensive "`src/common/webview/` does not exist" line;
`src/shared/state/stateKeys.ts:10,12`) and once in ratchet complexity
(`subsystemEdgeRatchet.vitest.ts:43-56` invents two pseudo-subsystems,
`common-state-extension` and `common-webview-extension`, with a 5-line comment).

**Recommendation:** rename to `@extCommon/state` and `@extCommon/webview`, reserving
`@common/*` for `src/common/*`. This is the one item in the survey that genuinely
misleads a stranger — `@common/state` reads as core code and is not. But it is not
free:

- **52 import statements** (33 `@common/state` + 19 `@common/webview`).
- **4 alias configs**: `tsconfig.json`, `tsconfig.build.json`,
  `packages/extension/tsconfig.json`, `packages/desktop/tsconfig.paths.json`.
- **4 `eslint.config.mjs` sites**: `:78`, `:83` (per-alias messages in
  `HOST_LAYER_RESTRICTED_IMPORT_PATHS`) and `:99-100`
  (`HOST_LAYER_RESTRICTED_IMPORT_PATTERNS`).
- **2 packaging scripts**: `scripts/verify-desktop-package.mjs:482` and
  `scripts/verify-desktop-build-artifacts.mjs:109` both emit
  `@common/state/stateKeys` in invariant error text.
- Docstrings at `src/shared/state/PersistedState.ts:17` and
  `src/shared/state/stateKeys.ts:10,12`.

**Critical:** the `SUBSYSTEM_ALIASES` carve-out in `subsystemEdgeRatchet.vitest.ts:47-51`
must be **renamed, not deleted**. It is not a workaround for the naming collision —
it is a deliberate guard so a future `src/`-side import of a VS Code-coupled module
produces a new-edge ratchet failure instead of being absorbed into the `common`
baseline. Its own comment says so. Deleting it silently removes the guard. Same for
the `CLAUDE.md` line, which stays useful as a pointer. `scripts/aliases.mjs`
auto-derives build aliases from tsconfig, so no Vite or esbuild edit is needed.

### C. `src/test-kernel/` — **`test-kernel/` at the root, not `tests/`**

Three options: leave it, `git mv src/test-kernel tests`, or `git mv src/test-kernel
test-kernel` (a pure `src/` prefix strip).

**Recommendation: the prefix strip.** The `tests/` rename additionally churns
`typecheck:test-kernel` (`package.json:25,27`), `tsconfig.test-kernel.json`,
`eslint.config.mjs:423`, and 135 doc mentions across 48 `.md` files, for no
structural gain. The prefix strip is mechanically the smallest diff that fixes the
actual defect: `ls src/` stops being dominated by non-source, and casual LOC counts
of `src/` stop reporting roughly double the real production size. See §6 for
sequencing — this is a pre-flip-only move.

### D. `src/latex/latexdiff.ts` — **rename, don't stutter**

`@latex/latexdiff` currently resolves to `src/latex/latexdiff.ts`. Move it into
`src/latex/latexdiff/` and the specifier becomes unresolvable (there is no
`index.ts` there, and adding one runs into the no-convenience-barrels rule), forcing
all 6 importers to `@latex/latexdiff/latexdiff` — a stutter that reads worse than
what it replaced.

**Recommendation:** if this is done at all, rename on move
(`latexdiff/orchestrator.ts`; note `latexdiff/service.ts` already exists). Otherwise
leave it and do only `texFormatter.ts` (item 7).

### E. `packages/extension/src/webview/` — **keep the directory name**

Renaming it to `mainView/` would make all three views spell alike and align with
root `src/shared/schemas/mainView/`. It would also touch 8 hardcoded string sites,
two of which fail silently and ship a broken VSIX (`.vscodeignore:52`,
`verify-vsix-contents.mjs:184`), and the string derives the **dist folder name**
(`vite.config.ts:44-45`), so the rename cascades out of `src/`. **Recommendation:**
move only `MainViewProvider.ts` into it (item 13) and note the naming asymmetry in
`AGENTS.md`.

### F. `packages/desktop/src/*` filenames — **keep the `desktop` prefix**

Ten of the 12 files moving in item 9 carry a redundant `desktop` prefix inside
`packages/desktop/`. Dropping it reads better
(`desktop/src/shared/shellMessages.ts`) but doubles the diff, destroys
`git log --follow` continuity on 10 files at the exact moment strangers start
reading history, and creates `packages/desktop/src/shared/` filenames that collide
conceptually with root `src/shared/` reached via `@shared/*` **in the same files**.
**Recommendation:** move the directory, keep the names.

### G. `@types/*` — **delete** (item 2). `@traceViewer/*` — **add**, with the eslint pattern from §4.12.

---

## 6. Sequence

The distinguishing property: **moves that break `git blame` and invalidate open
branches are cheapest while the repo is private and has no forks.** Anything on the
pre-flip list should be paid for now or deferred indefinitely.

### Before the open-source flip

**Wave 0 — blockers owned elsewhere.** Resolve root `LICENSE` (8 bytes, content
`LICENSE\n`) and the contradictory `docs/package.json:22` `"license": "MIT"` against
three packages declaring proprietary. Tracked in
`2026-07-29-open-source-readiness.md` and
`2026-08-01-open-source-readiness-audit.md`. Nothing in this document
depends on it, but it gates the public push.

**Completed waves — no future scheduling:** items 1-9 and 11-15 are complete, through merged PRs
#9537/#9539/#9541 and a follow-up change on `claude/file-directory-organization-gafp4f` (items 8, 9,
12, 13; item 14 was already satisfied). Do not carry them into new implementation waves or rebudget
their historical blast radii.

**Wave 3 remainder — the blame-breaking moves not yet attempted. Pre-flip or never.**

| Item                                               | Must be a single atomic commit because                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18 = §5.C (`src/test-kernel` → root `test-kernel`) | 875 renames + 9 config files + 3 ratchet path rewrites; see below                                                                                             |
| §5.B (`@extCommon/*`) if adopted                   | 52 specifiers + 4 tsconfigs + 4 eslint sites + 2 scripts + the ratchet `SUBSYSTEM_ALIASES` rename must land together or the ratchet guard silently disappears |

Items 8 and 9 (originally listed here) are done — see the table in §2.

**The test-kernel move (§5.C), in full.** Config edits (9 files): `vitest.config.mjs`
lines 18/21/26/28; `tsconfig.json:58` (alias) and `:77` (exclude — delete);
`tsconfig.build.json:45` (exclude — delete, **only in this commit**; under
`rootDir: "."` it is what stops `.d.ts` emit walking the whole repo, so deleting it
speculatively makes `@texra-ai/agent`'s declaration build emit for 875 test files);
`tsconfig.test-kernel.json` include globs; `knip.json:7`; `eslint.config.mjs:50`
and `:540`; `packages/desktop/tsconfig.paths.json:50` **regenerated** via
`scripts/sync-tsconfig-paths.mjs` (CI gates it at `ci.yml:139-140`).

Ratchet path rewrites: `host-agent-mock-baseline.json` (40 entries),
`knip-baseline.json` (2), `shared-schemas-deep-import-baseline.json` (1).
`architecture-edges-baseline.json` and `host-agent-import-baseline.json` need
**zero** — verified: the baseline has 0 test-kernel refs and
`subsystemEdgeRatchet.vitest.ts:72` returns null for `subsystem === 'test-kernel'`.
This is the load-bearing fact that makes a top-level `src/` move affordable here and
nowhere else in the repo.

**Rewriting those 40 baseline entries is not sufficient — the scan roots are also
hardcoded in test code.** `hostAgentMockRatchet.vitest.ts:48-51` builds
`HOST_DIRS` by resolving the literal paths `src/test-kernel/cli` and
`src/test-kernel/desktop` against the repo root. After the move `sourceFilesUnder`
finds no files, and because the assertions only require the current count to be
**≤** baseline, zero sites trivially satisfies them: the suite stays green while
silently guarding nothing. This is the same failure shape as the
`excludeTestKernel` trap below, and it must be in the atomic commit. Both
`HOST_DIRS` entries need rewriting alongside the baseline.

Depth-anchored code — **22 files resolve paths at runtime with `../../..`**, and one
is shared infrastructure: `src/test-kernel/support/repoScan.ts:10-13` sets
`REPO_ROOT = resolve(<support dir>, '../../..')`, used by 5 architecture ratchets.
Under a root-level `test-kernel/support/` that resolves _above_ the repo root. Also
`desktopTestPaths.mts:7`, `cli/CliSkills.vitest.mts:52`,
`tools/setup/ApplyTeamTool.vitest.mts:33`,
`commands/AgentCreatorTemplateSchema.vitest.ts:17`.

Test assertion: `src/test-kernel/scripts/AliasMapGeneration.vitest.ts:32` hard-asserts
`'@test/*': ['src/test-kernel/*']`.

**Do not blanket-delete `excludeTestKernel` call sites.** Six of eight are safely
deletable (`progressEventHandlerRetirement.vitest.ts:35`,
`sharedSchemasDeepImportRatchet.vitest.ts:560`,
`sessionFactAmbientHelperRetirement.vitest.ts:28`,
`dependencyDirection.vitest.ts:113` and its four siblings). Two are not:
`src/test-kernel/architecture/agentRuntimeProgressEventsBoundary.vitest.ts:41-62`
computes both `PRODUCTION_FILES = scanFiles(true)` and
`ALL_SOURCE_FILES = scanFiles(false)`, and the `false` branch **deliberately** scans
test-kernel — its allowlist at `:36-39` pins three `src/test-kernel/cli/*.vitest.mts`
files as permitted importers of the NDJSON vocabulary. Move the tests to a root
directory not in `SCAN_ROOTS` and delete the option, and the ratchet **stays green
while losing its coverage**. Correct execution: **add** the new root to
`SCAN_ROOTS` and re-express the partition by root.

Verified unaffected by the move: CI (`ci.yml:206` is
`pnpm run test --shard=…` with no path; the changes filter at `:60` is
`grep -vE '^docs/|\.md$'`), and all four packaging paths — `.vscodeignore`'s
`src/**` at `:15` is package-relative and never reaches root `src/`;
`electron-builder.yml` `files:` is `dist` + `package.json` + node-pty;
`packages/cli/package.json` and `packages/agent/package.json` ship `files: ["dist", …]`.
No esbuild or Vite entry config references test-kernel. **Say this in the commit
message so no reviewer re-derives it.**

Doc rot: 135 test-kernel mentions across 48 `.md` files, of which only ~9 are
gate-enforced (AGENTS.md ×4, `.claude/skills/code-review/references/review-checklist.md`
×3, `docs/dev/verification.md` ×1); ~117 in `docs/proposals`, `docs/prds`, and
`docs/architecture` are uncovered. Plus **6 production source files** carrying
`src/test-kernel/...` doc comments that no gate sees (the scanner is `.md`-only):
`src/platform/defaults/fsEntryTypeBits.ts:4`, `src/auth/config.ts:115,134`,
`packages/desktop/src/renderer/desktopCommandPalette.ts:67`,
`packages/extension/src/webview/frontend/persistence.ts:12`,
`scripts/aliasUtils.mjs:47`, `scripts/check-dead-code-ratchet.mjs:12`.

Before committing any Wave 3 item: do it in a scratch worktree and run
`npm run typecheck && npm test && npm run lint && npm run check:tsconfig-paths &&
npm run check:guidance-refs && node docs/scripts/check-root-docs.mjs`.

### After the flip

Item 10b (trace-viewer generated path-map and knip ownership) is the only item left. Item 11's
relocation landed in PR #9537; optionally consolidate or index the 21 checkpoint files now in
`docs/dev/audits/`. None of this requires moving those files again.

### Deliberately never

Everything in §3.

---

## 7. Left alone deliberately

So nobody "fixes" these later.

1. **Directory naming.** 161 distinct segments under `src/` and `packages/*/src/`:
   132 lowercase single-word, 19 camelCase, 1 kebab (`trace-viewer`, a package
   name), 0 PascalCase, 0 snake_case. The two underscore-prefixed dirs
   (`packages/cli/src/chat/tui/forms/_shared/`,
   `packages/cli/src/commands/_helpers/`) are a deliberate "not a domain folder"
   marker. State it as the rule; change nothing.

2. **The alias system and its generation.** Alias imports dominate and relative
   imports stop short of depth 4, enforced by the custom auto-fixable
   `local/prefer-alias-for-deep-relative-imports`. `tsconfig.json` is the single
   hand-edited source; `scripts/sync-tsconfig-paths.mjs` code-generates the
   extension and desktop maps with a `--check` CI diff gate;
   `scripts/aliases.mjs` derives the bundler map for all four Vite configs and
   vitest. The 44/39-key delta between root and extension is intentional
   derivation (`EXTENSION_EXCLUDED_ALIASES`), not drift. This is the single reason
   every move above is affordable.

3. **`config/ratchets/architecture-edges-baseline.json`.** 96 directed edges over
   18 nodes with a `semantics` field explaining the type-only/value distinction.
   It is the machine-checked layering document most repos never write, and it is an
   asset for an open-source reader. Every proposal above is scoped to preserve it
   rather than force a regeneration.

4. **`src/agent/core/` and `src/agent/modelHandlers/`.** Clean decomposition with
   READMEs (`definition/ flows/ state/ tools/ usage/`;
   `anthropic/ google/ openai/ openrouter/ vscodelm/ support/ utils/`). Any future
   reorg of `src/tools/` should copy this shape.

5. **`src/platform/` and `src/controllers/`.** Interfaces at the root with 14
   implementations under `defaults/` — a legible port/adapter split.
   `src/controllers/` mirrors host views 1:1 with **zero** loose files at the
   subsystem root.

6. **`src/shared/schemas/index.ts`** and the other compliant barrels. It is an
   explicitly documented public surface enforced by
   `shared-schemas-deep-import-baseline.json` +
   `sharedSchemasDeepImportRatchet.vitest.ts`, which classifies every deep import
   as `forced` or `gratuitous`. `src/common/errors/index.ts` and
   `src/utils/files/index.ts` carry hand-written "these are NOT re-exported"
   notes — the no-convenience-barrels rule being enforced by hand. Total barrel
   count is 38 across 2,417 files (1.6%).

7. **The one-Vitest-root convention.** Zero colocated tests anywhere in `src/**`
   or `packages/*/src/**` — verified by glob, and rarer than it sounds. Do not
   "fix" test-kernel by scattering 875 files next to their sources.
   `src/test-kernel/architecture/` (10 ratchets, each named for what it pins) and
   `src/test-kernel/support/` (a composition root registered at
   `eslint.config.mjs:50` alongside `extension.ts` and `initPlatform.ts`) move as
   units.

8. **`packages/cli/src/`** — the best-organized host tree in the repo
   (`commands/` one file per subcommand with `_helpers/`, `runtime/`, `schemas/`,
   `onboarding/`, `bin/`). **`packages/desktop/src/{main,preload,renderer}`** —
   correctly mirrors Electron's own process vocabulary even though it does not
   match the other two hosts. **`packages/extension/resources/` internal shape** —
   the categories are clean; only its 12 loose siblings at `packages/desktop/src/`
   root were the problem.

9. **`.github/`** — 12 workflows with prompts factored into `.github/prompts/`
   (7 files, consumed by 6 workflows) rather than inlined in YAML, and tool
   allowlists in `.github/automation/allowed-tools.json` keyed by workflow role.
   This is a model other repos should copy.

10. **The docs date-prefix gate.** `docs/scripts/check-root-docs.mjs` mandates
    `YYYY-MM-DD-` in `prds`/`proposals`/`dev/audits`, rejects double-dated names,
    and catches audit/prd/proposal-marked files anywhere lacking a prefix.
    Compliance is 100%. **`docs/.vitepress/publicDocs.js`** is a genuine single
    source of truth, deliberately dependency-free (`:5-8`) and _consumed_ rather
    than duplicated by the gate — preserve that property. The second allowlist in
    `.github/workflows/docs-deploy.yml:46-49` is stated defense-in-depth, not
    accidental duplication.

11. **`docs/prds/`** — a README index, 76/76 files with `created`/`updated`
    frontmatter, and a `cli-tui-ink/` sub-package with its own README and an
    `NN-`-ordered `mockups/` subdirectory. That subdirectory is the template
    `docs/proposals/` should follow. **`docs/guide/`** — flat, kebab-case, 33
    files; correct granularity for a user guide, do not subdivide.

12. **`skills/` package shape** (all 14 exactly `SKILL.md` + `references/<one>.md`
    - `agents/openai.yaml`), **`patches/`** (2 files, `<pkg>@<version>.patch`,
      wired through `pnpm-workspace.yaml` `patchedDependencies`),
      **`config/ratchets/` naming** (`<subject>-baseline.json`), and the split
      between `.claude/` (repo-development skills) and `skills/` (product skills).

13. **No cross-package duplication.** An exhaustive md5 sweep over every tracked
    file in `packages/` and `src/` found exactly **one** byte-identical pair, and
    it is a logo (`packages/desktop/build/icon.png` ==
    `packages/extension/resources/logo-512x512.png`). Two hypotheses tested and
    rejected: `packages/cli/src/runtime/updateChecker.ts` (456 lines) vs
    `packages/desktop/src/main/desktopUpdateChecker.ts` (152) share their core via
    `@shared/state/stateKeys` and `@utils/system/envFlags`; the ~40 same-basename
    pairs (`agents.ts`, `history.ts`, `memory.ts`, `doctor.ts`, `tools.ts`,
    `skills.ts`) are the CLI's deliberate thin-command / implementation split.

14. **`src/tools/wolfram/test/check.wl`** is _not_ a runtime asset — it is an ad-hoc
    physics scratchpad (spinor eigenstates, Pauli matrices, `Print` statements) with
    no code path constructing its path. Do not rename it to `resources/`; that
    replaces one misleading name with another. `git rm` it or leave it.

---

## Coverage gaps

Stated honestly so nobody assumes more rigor than exists.

- **No proposed implementation move was executed.** The PR-head reconciliation reran the path,
  alias, dependency, browser-reachability, and checkpoint censuses plus the focused guidance and
  docs checks. No scratch `git mv`, full typecheck, or full ratchet run was used to prove the
  remaining move blast radii. Every "this does not change the edge set" claim is still derived
  from _reading_ `subsystemEdgeRatchet.vitest.ts`'s first-path-segment keying logic,
  not from running it. Every blast radius is a grep count. The most likely place a
  count is off is the ~22 depth-anchored relative escapes in `src/test-kernel/`.
- **`src/agent/` was surveyed two levels deep.**
  `src/agent/implementations/flows/` (20), `src/agent/storage/` (13), and
  `src/agent/output/` (18) were counted but not read file-by-file. Finer-grained
  issues may exist inside them.
- **`docs/` findings were deliberately narrowed** to specific non-obvious calls per
  the brief. The internal _content_ of the 148 prds/proposals was not read beyond
  filenames, frontmatter presence, and `supersed*` greps — so claims about which
  proposals are semantically superseded are limited to what those show.
- **Test quality and coverage were not assessed** — no judgment on whether 824
  suites over 166,367 LOC of production code is the right ratio, whether suites
  duplicate each other, or whether any are skipped. Note `packages/agent` (10 files)
  has no identifiable test directory and `packages/trace-viewer` (10 files) has one
  test file; whether that is correct for thin re-export packages is unexamined.
- **`supabase/`** (73 tracked files) was out of scope except where `docs/supabase/`
  bears on it.
- **`.vitepress/config.js` sidebar/nav structure** and the contents of
  `docs/public/` assets were not examined.
- **Whether the `@texra` npm scope is owned** could not be determined from the
  repo — `release.yml` only ever publishes `@texra-ai/*`, which is suggestive but
  not proof. Ask before acting on §5.A's rename branch (which is recommended
  against anyway).
- **One false lead recorded so nobody re-investigates:** an early grep suggested 14
  external citations of `docs/reference/`. All 14 were inside gitignored
  `packages/desktop/dist/` build output (Supabase SDK doc URLs). The true count of
  citations from tracked non-docs files is **zero**. Similarly,
  `docs/.vitepress/dist/` is 9.1 MB on disk but gitignored with 0 tracked files —
  not a clone-size problem.
