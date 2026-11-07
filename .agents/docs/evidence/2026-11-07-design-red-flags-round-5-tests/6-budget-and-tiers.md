# Lens 6: budget and tiers

Commit: `main` at `c9ceb23` ("simplify(test): the fake host is a service, not
a module slot (R3-R R6) (#14826)").

Scope: every vitest suite (`src/test-kernel/**`, `packages/*/test/**`), the
llm live suites, the desktop Playwright specs and `supabase/functions/**/*_test.ts`.
Read-only. One measured full run, plus per-project runs and two scratch-config
runs to check claims (configs in the scratchpad, nothing in the tree changed).

## Numbers

**The full run.** `npx vitest run --config vitest.config.mjs --reporter=json
--outputFile=/tmp/claude-0/-home-user-TeXRA/282a79e8-4cfa-59b7-ad57-f935b38bcc7e/scratchpad/vitest.json`
on 4 cores (`maxWorkers: '50%'`, so 2 workers):

- 246 files, 518 tests: 517 passed, 1 skipped, 0 failed. Wall 81.5 s
  (user 2 m 34 s).
- Per project, from the same JSON (file time is the sum of each file's
  `endTime - startTime`, which leaves out module import), and wall time from
  one run of each project alone:

| Project    | Files | Tests | File time (full run) | Wall alone | Wall split (Vitest's summary)              |
| ---------- | ----: | ----: | -------------------: | ---------: | ------------------------------------------ |
| `crash`    |     7 |     9 |               60.9 s |     31.6 s | tests 93 %                                 |
| `kernel`   |   106 |   208 |               26.6 s |     16.6 s | tests 76 %, import 12 %                    |
| `isolated` |    34 |    74 |                6.3 s |     26.0 s | import 52 %, setup 17 %, **tests 17 %**    |
| `pure`     |    99 |   227 |                2.1 s |      4.5 s | import 39 %, transform 30 %, tests 24 %    |
| `!crash`   |   239 |   509 |                    — |     49.5 s | tests 44 %, import 35 %                    |

Per file, alone: `pure` 0.045 s, `kernel` 0.16 s, `isolated` 0.77 s. The
`crash` project is 63 % of the suite's test time. `isolated` is 14 % of the
files and runs longer alone than `kernel`, which has three times as many
files.

**Top 15 files by duration** (full run, file time):

| #   | Time   | Tests | File                                                                                  | Slowest test, and why it is slow                                                                                       |
| --- | ------ | ----: | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | 15.4 s |     1 | `packages/harness/test/controllers/session/crashConformanceResume.1.vitest.ts`        | resumes from every commit point (one test replays each of its commit points)                                           |
| 2   | 14.9 s |     1 | `…/crashConformanceResume.2.vitest.ts`                                                | same                                                                                                                   |
| 3   | 12.8 s |     1 | `…/crashConformanceResume.3.vitest.ts`                                                | same                                                                                                                   |
| 4   | 12.6 s |     1 | `…/crashConformanceResume.4.vitest.ts`                                                | same                                                                                                                   |
| 5   | 6.6 s  |     4 | `packages/harness/test/utils/system/SystemUtils.vitest.ts`                            | 3.0 s: a host `SIGKILL`ed with a background job. Real process time is what it tests                                    |
| 6   | 4.2 s  |     2 | `src/test-kernel/controllers/session/sessionStore.vitest.ts`                          | 3.7 s: R24. Six injected read faults ride the view's real `Schedule.exponential('50 millis')`, `times: 5` (`sessionInputs.ts:57-59`), on a live clock |
| 7   | 3.3 s  |     6 | `src/test-kernel/agent/runtime/resumeRun.vitest.ts`                                   | 0.7 s each: a crash, then a resume over a real store                                                                   |
| 8   | 3.3 s  |     3 | `…/crashConformanceChildResults.1.vitest.ts`                                          | 2.2 s: a detached command a dead process left running                                                                  |
| 9   | 2.3 s  |     2 | `src/test-kernel/agent/runtime/AgentLaunchActivation.vitest.ts`                       | 1.3 s: R6, agent file against inline persona                                                                           |
| 10  | 1.7 s  |    15 | `src/test-kernel/controllers/session/sessionEvents.vitest.ts`                         | 1.0 s: refuses a store another OS process holds (a real child process)                                                 |
| 11  | 1.7 s  |     3 | `src/test-kernel/effect/sessionPrograms.vitest.ts`                                    | 0.8 s: R14                                                                                                             |
| 12  | 1.1 s  |     3 | `src/test-kernel/agent/CodeSandbox.vitest.ts`                                         | 0.6 s: QuickJS                                                                                                         |
| 13  | 1.0 s  |     7 | `src/test-kernel/controllers/session/goldenStore.vitest.ts`                           | 0.3 s                                                                                                                  |
| 14  | 1.0 s  |     1 | `…/crashConformanceChildResults.2.vitest.ts`                                          | 1.0 s                                                                                                                  |
| 15  | 0.9 s  |     4 | `src/test-kernel/agent/ToolUseDispatchParallel.vitest.ts`                             | 0.5 s                                                                                                                  |

The crash shards re-run the clean pass in each file. A scratch shard that
replays no point (`crashConformanceSuite(['resume'], { index: 9999, count:
10000 })`) ran its clean pass in about 1.8 s (23 % of 7.9 s). So four shards
spend about 7 s of their 56 s on the repeated clean pass (about 13 %). The
rest is replay, one resume per commit point. That cost comes with the
invariant being tested, and it is not a finding (see "Good suites").
`SystemUtils` and `sessionEvents`' cross-process case need real time. R24's
3.7 s is a live-clock retry; lens 4 owns that.

**Skipped and conditional** (vitest: no `.skip` and no `.todo` in any suite):

- `src/test-kernel/schemas/rowVersions.vitest.ts:182`: `it.runIf(FREEZING)`.
  This is the one test the run skipped. It writes the frozen fingerprints, and
  `npm run storage:freeze` runs it (`package.json:39`). It is a generator
  inside a suite, with its own script.
- Platform gates: `LeanServerPool.vitest.ts:213`, `FileSecrets.vitest.ts:24`,
  `PathResolution.vitest.ts:53` (`skipIf(win32)`), and `OutputGuards.vitest.ts:59`
  (a runtime `context.skip()` when the filesystem refuses a symlink).
- `packages/llm/test-live/support.ts:249`: `describe.skipIf(bound === null)`,
  which skips a route that has no key. That is by design.
- Playwright: `proposalEdit.spec.ts:84` and `serviceClient.spec.ts:37` skip
  on win32. `menuLifetime.spec.ts:26` and `sessionLifecycle.spec.ts:141`
  skip off macOS. All are platform facts with a reason string. None hides a
  broken test.

**Tests of behaviour 1.0 deleted.** I found none. Every "legacy", "compat",
"pre-1.0" and "migrat" hit tests current behaviour. They are listed under
"Already settled".

## Findings

### 1. The `isolated` tier costs more than `kernel`, and 18 of its 34 suites are there to mock a repository module

**Flags:** information leakage (a suite that mocks a repository module knows
which module calls which); a cost the tier table names and the suites pay.

**Evidence.**

- Measured above: `isolated` alone runs in 26.0 s for 34 files and 74 tests,
  with tests 17 % of that. `kernel` runs in 16.6 s for 106 files. Each
  isolated file costs about 0.6 s of import and setup before its first test.
- Why each suite is isolated (from the scan in `vitest.config.mjs:116-121`
  and the suites' own lines):
  - **`vi.mock` of a repository module (18):** `cli/ExecuteCli.vitest.ts:125-151`
    (5 mocks), `cli/InstallGithubAction.vitest.ts:25,32`,
    `cli/ModelAccess.vitest.ts:16,22`, `cli/OverleafCloneCommand.vitest.ts:27,34`,
    `cli/ResumeCommand.vitest.ts:38,42`, `cli/SessionExitController.vitest.ts:17-31`
    (4), `cli/TuiApprovalRetry.vitest.ts:16-41` (4),
    `cli/WorkflowRunCommand.vitest.ts:57-82` (4),
    `cli/chatSessionController.vitest.ts:40-52` (4+),
    `latex/LatexdiffShadowStorage.vitest.ts:23`, `latex/TexTools.vitest.ts:18`,
    `tools/GitHubPullPoll.vitest.ts:25,31`,
    `tools/PRPollingSourceAnnotationPages.vitest.ts:28`,
    `agent/output/CompileCheck.vitest.ts:35`,
    `agent/output/LatexCompileInputDirs.vitest.ts:44-52`,
    `controllers/session/sessionEvents.vitest.ts:50,110,114`,
    `tools/setup/CredentialReporting.vitest.ts:31`,
    `desktop/DesktopSettingsIpc.vitest.ts:18`. All paths are under
    `src/test-kernel/`.
  - **Node or third-party edge (3):** `cli/TerminalCleanup.vitest.ts:19`
    (`node:fs`), `packages/harness/test/tools/WebFetchTool.vitest.ts:13,92`
    (`undici` plus `vi.resetModules`), `desktop/ElectronHostBridge.vitest.ts:22-23`
    (`electron`).
  - **A DOM (2, maybe 3):** `progressView/BashRequestPanel.vitest.ts`
    (Lit, through `settings/litComponentTestUtils.ts`),
    `packages/texra/test/progressView/MarkdownRendererSecurity.vitest.ts:2`
    (`jsdom`). `progressView/SessionSurfaces.vitest.ts:3` imports
    `@lit-labs/signals`. It passed in a shared registry (finding 2), so it
    probably needs no DOM.
  - **The directory name only (11):** finding 2.
- `src/test-kernel/AGENTS.md` "Test tiers": "do not mock repository modules.
  A `vi.mock` is what moves your suite to the slow tier". The 18 suites
  above break that rule. Four of them are on the brief's churn list:
  `sessionEvents` 13, `ExecuteCli` 10, `chatSessionController` 9,
  `TuiApprovalRetry` 9. The mocks are what tie them to the module graph.
- An example of what a mock costs in coverage:
  `cli/ExecuteCli.vitest.ts:256-264` replaces the CLI's headless
  approval adapter with a stub that recomputes its decision
  (`approvalPromptsUnavailable: context.mode !== 'interactive'`). The
  "approval-unavailable" cases at `:331-347` then assert that decision
  (`expect(seen()).toBe(true)`). The real decision,
  `packages/cli/src/runtime/headless/approvalAdapter.ts:199`, is mocked out.
  Lens 3 owns this.

**The design decision behind it.** These suites set the boundary for each
test at a module the command imports, not at the host ports. The ports
already have shared fakes (`FakeHost`, `ValidationModel`, the scripted HTTP
edge).

**The better design.** Each suite drops its repository mocks and drives the
command over `FakeHost` / `SessionGraph.hosted`. For the CLI suites, it
asserts at the CLI's output and the session's rows. The per-suite fix belongs
to lenses 1 and 3. This lens adds only the price: each suite that leaves the
tier saves about 0.6 s of import and setup per run, and when it joins the
kernel registry it shares that registry's warm imports. For the 18 together,
expect most of the 20 s of non-test wall time in `isolated` to go (an
estimate; I did not measure it per suite). Deleted: the `vi.mock` factories
(about 40) and the `mocks` hoists that feed them.

**What we give up.** Fine-grained call assertions (`toHaveBeenCalledExactlyOnceWith`
on `stopRequest`, `ExecuteCli.vitest.ts:375`). Replace them with the stored
`run.stop` row they stand for.

**Change amplification.** Change: rename one `@cli/runtime/headless/*`
module. Before: the module, its importers, and each suite that mocks it by
path (`ExecuteCli`, `chatSessionController` and `ResumeCommand` mock overlapping
sets). After: the module and its importers.

**Sequencing.** `chatSessionController`, `TuiApprovalRetry` and
`SessionExitController` sit in the TUI lifecycle area. Go with A's TUI
lifecycle PR (which files it touches is unverified). `sessionEvents` borders
`.agents/docs/proposed/simplification/2026-11-04-store-and-test-support-debts.md`
C7, which already found its `SqliteClient` and Lean mocks. This report does
not repeat that.

**Depends on:** none per suite. Lenses 1 and 3 name each replacement.

### 2. `DOM_DIRS` isolates 11 suites by directory name, one of its three directories holds no suite, and its helper's reason is gone

**Flags:** special and general mixed (a declared list beside a computed
scan); a comment that is no longer true.

**Evidence.**

- `vitest.config.mjs:122-126`: `const DOM_DIRS = ['desktop', 'progressView',
  'settings'];`. The reason given is that "their suites bring a window or
  load modules afresh through helpers a scan of the suite does not see
  (`settings/litComponentTestUtils.ts`, `desktop/loadSourceModule.ts`)".
- `src/test-kernel/settings/` holds no suite, only
  `litComponentTestUtils.ts`. Its one consumer is
  `progressView/BashRequestPanel.vitest.ts`.
- `src/test-kernel/desktop/loadSourceModule.ts:11-14` says it imports by
  file URL "so a test observes a module instance of its own (fresh across
  `vi.resetModules()`, and built after any `vi.mock()` this file installs)".
  Its two consumers, `desktop/JsonStore.vitest.ts:18` and
  `desktop/DesktopNavigationPolicy.vitest.ts:10`, call neither
  `vi.resetModules` nor `vi.mock` (grep). `JsonStore` tests a harness module
  (`@platform/defaults/jsonStore`), and it lives under `desktop/`.
- 11 suites under these directories match no `NEEDS_OWN_REGISTRY` pattern:
  `desktop/{DesktopAppLog,DesktopNavigationPolicy,DesktopToolEditApproval,DesktopWorkspaceIpc,JsonStore}`,
  `packages/desktop/test/desktop/{DesktopShellState,DesktopWindowLifecycle,ElectronCompositionRoot}`,
  `packages/harness/test/desktop/DesktopLogRedaction`,
  `packages/texra/test/progressView/fileDropHandler`,
  `progressView/SessionSurfaces`. All 11 (19 tests) pass in one shared
  registry: a scratch config with `isolate: false`. Wall alone: 7.57 s
  isolated, 6.78 s shared. That is a modest gain when they run alone. In the
  full run they would also join a registry that is already warm (no
  per-suite measurement).
- The R3-R round's R7 replaced the name list for "reaches a host" with the
  closure walk now at `vitest.config.mjs:67-90` (`reachesAHost`). `DOM_DIRS`
  is the declared list that walk left in place. `src/test-kernel/AGENTS.md`:
  "There is no list of exempt suites or modules."

**The design decision behind it.** "Needs its own registry" is a fact about
the import closure, as "reaches a host" is. The config decides it once by
walking the closure and once by directory name.

**The better design.** Let the same closure walk report a DOM import
(`NEEDS_OWN_REGISTRY` patterns 3 and 4) reached through `@test/*` or a
relative helper. That catches `BashRequestPanel` through
`litComponentTestUtils.ts`. Then delete `DOM_DIRS` (3 names) and the comment
at `:122-125`. Delete `loadSourceModule.ts` and the alias table in it; its two
suites import by alias. Move `JsonStore.vitest.ts` to
`packages/harness/test/platform/`. About 40 lines are deleted and about 10
added in the config.

**What we give up.** Nothing a suite uses. A new DOM helper that the walk
cannot follow (a dynamic import with a computed path) would land in a shared
registry and fail loudly (`d.createComment is not a function`). It would not
pass silently.

**Change amplification.** Change: add a pure state suite under `desktop/`.
Before: it pays the isolated tier and nothing says why. After: the scan
decides.

**Depends on:** none. It borders the R3-R round's R7
(`../2026-11-07-design-red-flags-round-3/R-test-infrastructure.md`, R7),
which landed the closure walk.

### 3. Behaviour contracts in Playwright projects that no job runs

**Flags:** special and general mixed (the Playwright project is picked per
file, and one file mixes visual baselines with behaviour); a contract with no
protection.

**Evidence.**

- `packages/desktop/playwright.config.*:24-30`: the `desktop` project
  ignores `screenshots.spec.ts` and `devStartup.spec.ts`. `appearance` and
  `development` run only those two files.
- CI runs only `test:e2e` (`.github/workflows/ci.yml:411`). A grep of
  `.github/` for `test:appearance`, `test:dev` and `--project=` finds
  nothing else. `desktop-package.yml:108` only installs Playwright's system
  dependencies.
- In `screenshots.spec.ts`, three tests are behaviour, not baselines:
  - `:98`: the command palette opens and dismisses
    (`expect.poll(commandPaletteIsClosed).toBe(true)`);
  - `:116`: "The vertical settings navigation must remain operable by
    keyboard, and its controls must stay reachable when the native window
    shrinks";
  - `:281`: "appearance settings override the system and remember the
    choice" (`page.reload()`, then `toHaveJSProperty('value', 'dark')`,
    then forced colors).
- `devStartup.spec.ts:17`: "renders the dev app from a cold cache and
  restores the editor after reload". The editor restore is a user contract.
- The README frames `appearance` as visual review "rather than in every
  development loop" (`packages/desktop/tests/e2e/README.md`). Nothing
  diffs the baselines ("Nothing diffs against it"). So these behaviour
  checks run only when someone remembers to.
- Overlap inside the run project: `trajectories.spec.ts:243` ("rapid
  settings-tab switching does not crash the renderer") is the one settings
  navigation check that runs in CI. It asserts only that the chrome is still
  visible.

**The design decision behind it.** The project encodes "does this spec need
a person to look at it". The behaviour tests were put in a file by topic
(appearance), which made them visual-only.

**The better design.** Move `:98`, `:281` and the keyboard and reachability
assertions of `:116` into `trajectories.spec.ts`, which already holds one
launch for many trajectories. Keep the screenshot captures in
`screenshots.spec.ts`. Move the editor-restore half of
`devStartup.spec.ts:17` into `workspaceTabs.spec.ts` (it restores grids and
editors, `:536`). The cold-cache Vite check can stay manual. About 120 lines
move, and no new launch is added.

**What we give up.** Some macOS CI time per run: the shared `trajectories`
launch absorbs it. These tests are not new, so this is not a new-test cost.

**Change amplification.** Change: a theme bug that loses the saved choice.
Before: CI is green until someone runs `test:appearance`. After: the desktop
job fails.

**Depends on:** none.

### 4. One fact tested three times: "every model id TeXRA pins is live in llm-zoo"

**Flags:** repetition; two representations of one check. One of them also
pins a choice, not a contract.

**Evidence.**

- `src/test-kernel/model/ModelOptionsBasic.vitest.ts:13-21`: the helper
  default resolves, `config?.provider` is `'deepseek'`, and it is not
  deprecated.
- `:27-34`: `DEFAULT_MODELS` holds no retired or deprecated id.
- `packages/texra/test/model/SetupModelDefaults.vitest.ts:21-37`: every
  `SETUP_MODEL_BY_PROVIDER` pin is known, not retired, not deprecated and not
  OpenRouter-only. `:38-50` also checks that the ChatGPT setup model routes
  to the subscription, which is a separate contract.
- Each comment says the same thing ("An llm-zoo bump that retires or
  deprecates …", `ModelOptionsBasic.vitest.ts:25-26`,
  `SetupModelDefaults.vitest.ts:16-18`). The helper case misses the
  `retired` check that the other two make. The `provider === 'deepseek'`
  assertion fails when the default changes on purpose, and it protects
  nothing a user sees.

**The design decision behind it.** "A pinned model id is live" is one
property over every literal model id the app ships. It was added once per
table, as each table appeared.

**The better design.** One `it.each` over the union of the pinned ids
(the helper default, `DEFAULT_MODELS`, `SETUP_MODEL_BY_PROVIDER`), each
labelled with its table, checking known, not retired, not deprecated and not
OpenRouter-only. It stays in `packages/texra/test/model/`. Delete
`ModelOptionsBasic.vitest.ts` (35 lines) and the deepseek pin. The ChatGPT
routing case stays. About 88 lines become about 45, in 1 file instead of 2.

**What we give up.** The per-table `describe` names. A test.each label
carries them instead.

**Change amplification.** Change: a fourth table of pinned ids (for example
a per-plugin default). Before: a fourth copy of the check, and it may again
miss `retired`. After: one more entry in the union.

**Depends on:** none.

### 5. E2E specs that re-assert what another tier or spec already proves

**Flags:** repetition across tiers.

**Evidence and verdict, one case at a time.**

- **The tool edit that another window answers.** It is tested in
  `src/test-kernel/desktop/DesktopToolEditApproval.vitest.ts:195-270` (with a
  five-entry failure list at `:195-202`). It is tested again, through the
  real app and service, in `packages/desktop/tests/e2e/serviceClient.spec.ts:275`
  (`:51-89` of that test: copy edited, other window approves, the edits are
  kept, one notice). The e2e adds what the kernel cannot reach: a real
  background service, and a later stale answer refused (`:90-98`). The
  duplication is deliberate. The CI path filter runs desktop e2e only for
  `packages/desktop/` and the session layer (`ci.yml:84-89`, "Everything
  else the app bundles is covered by the kernel tests"), and
  `ToolEditApprovalController` lives in `packages/texra/src/controllers/approval/`,
  outside that filter. **Keep both.** If the filter ever grows to
  `controllers/approval/`, delete the kernel case (about 75 lines).
- **`settingsPersistence.spec.ts:120`, "settings memory entries survive
  relaunch".** The test writes the memory file itself (`:28-35`), so the
  relaunch half proves only that the project resolves to the same storage
  path. `sessionLifecycle.spec.ts:167` already proves that, with stored runs
  and a byte-equal check (`expect(reloaded).toEqual(persisted)`). The first
  half, that the Memory tab lists a memory file, has no other test (grep of
  `getMemoryData` in suites). Fix: drop the relaunch (one cold Electron
  launch, about 15 lines) and fold the listing check into
  `trajectories.spec.ts`, which already has one launch and visits the
  `memory` tab at `:245`. Then delete the file (144 lines).
- **`trajectories.spec.ts:63`, "first launch shows a usable launcher
  chrome".** `launchTexraApp` already waits for `#app` and the renderer's
  ready marker (`electronApp.ts`, `waitForSelector('#app')` and the
  `waitForFunction` after it), and every later trajectory clicks
  `#shellNewTask` and `.shell-sidebar-action`. What it adds is the project
  name label (`toContain(workspaceDirectory)`). Fold that one line into
  `:85`'s setup and delete the test (about 22 lines). It would catch a wrong
  project name, which nothing else asserts. Keep that assertion.

**Depends on:** finding 3 (both move tests into `trajectories.spec.ts`).

### 6. 40 suites under `src/test-kernel/` test one package

**Flags:** a vague catch-all (`src/test-kernel/` holds both cross-package
suites and single-package suites).

**Evidence.** I mapped each suite's direct non-`@test` imports to their
package (through `scripts/aliases.mjs` and `@texra-ai/*`). Of 133 suites in
`src/test-kernel/`, 40 import from exactly one package: harness 21, texra 10,
cli 6 (`Pager`, `InputBar`, `CliRootArgs`, `OutputGuards`, `TerminalCleanup`,
`WorkflowInputsLifecycle`), desktop 2 (`ElectronHostBridge`,
`DesktopWorkspaceIpc`), llm 1 (`GoogleInteractions`). Another 4 import no
package alias at all (`DesktopPackageSmoke`, `CheckGuidanceRefs`,
`DesktopNavigationPolicy`, `EmailPolicy`); those are repo scans and scripts.
Root `AGENTS.md` "Layout": "A suite that tests one package lives in that
package's `test/`". Package suites already import `@test/support` (59 files),
so moving one changes nothing it reaches. This is an upper bound: a suite
can reach a second package through a support module (`texraApp.ts`), which
the direct-import map does not see. Unverified per suite.

**Fix.** One mechanical `git mv` PR for the 40, with tiers unchanged (the
tier comes from the first directory under the test root, and both roots use
the same names). Size: 40 files moved, 0 lines changed.

**Sequencing.** After B's rename PR and A's TUI lifecycle PR land. A move
under an open rename makes a merge conflict and protects nothing.

**Depends on:** none (only the sequencing above).

### 7. Two stale cost figures the testing guidance gives

**Flags:** a false comment.

- Root `AGENTS.md` "Commands": `npm run test:pure   # before a push (~30s)`.
  Measured: 4.47 s wall for 99 files. 30 s was the figure for the old
  isolated pure run (`vitest.config.mjs:30-31`, "Measured on 136 suites: 28s
  against 1m55s isolated", which is history and fine where it is).
- `.agents/docs/proposed/architecture/2026-10-27-tech-debt-target-designs.md:345`
  estimates "isolated suites 172 → ~55". At this commit `isolated` has 34
  (row A6 at `:634` says it landed). This is a dated note, so leave it.
  Only `AGENTS.md` is a live claim.

**Fix.** `(~5s)` in `AGENTS.md`. One line.

## Good suites worth copying

- **The crash conformance suite** (`src/test-kernel/support/crashConformance.ts`,
  7 one-line shard files). It costs 63 % of test time, and it pays for it:
  it is the only check of "resume from any commit point, nothing run twice,
  no result lost or read twice", with each invariant listed at its head
  (`:1-40`, `:1035-1050`). Its own project lets the edit loops leave it out,
  and sharding over files spreads it across workers. The repeated clean pass
  is about 13 % of its cost, which is not worth a fixture that would pin the
  store format.
- **`src/test-kernel/agent/runtime/resumeRun.vitest.ts`**: the failure list
  first (`:1-20`), one test per entry, over a real store, with faults
  injected through `StoreFaults`.
- **`src/test-kernel/controllers/session/goldenStore.vitest.ts`** with the
  crash suite: the header (`:1-21`) splits what the golden fixture covers
  (cleanly finished runs, plus one real `SIGKILL`) from what the crash suite
  covers (every cut).
- **`packages/desktop/tests/e2e/proposalEdit.spec.ts`**: a user path no
  kernel suite duplicates. It goes through roles and labels, and it checks
  the store rows (a copy of them) as its artifact.
- **`packages/llm/test-live/`**: one 10-to-14-line file per route over one
  capability matrix (`support.ts`), gated on the route's key.

## Already settled, left alone

- `sessionEvents.vitest.ts:563` ("retires a store written before 1.0 whole
  and starts clean") tests current behaviour, not a legacy reader.
  `packages/harness/AGENTS.md` "Storage format": "moves a pre-1.0 store
  aside whole at open (`texra.db.pre1`, never read again)".
- `goldenStore.vitest.ts:742` ("an earlier build's row") and
  `rowVersions.vitest.ts:132` ("reads or retires every row kind ever
  stored"): `DatabaseRowEarlier`, also in "Storage format".
- `rowVersions.vitest.ts:182` `runIf(FREEZING)`: a writer that
  `npm run storage:freeze` (`package.json:39`) runs. This is not a skipped
  test.
- `supabase/functions/log-usage/usageValidation_test.ts:39,113` (a legacy
  subscription flag, a legacy relay entry) and `log-usage/legacyStore.ts`:
  released clients' wire format. Root `AGENTS.md` "Compatibility and format
  retirement" allows "wire protocols TeXRA still supports", normalized once
  at the boundary.
- `SettingsAgentCatalogController.vitest.ts:48-56` (`LEGACY_ICON_PRESET`,
  unrecognized records preserved on save): "never delete existing user
  data" (root `AGENTS.md`, "TeXRA 1.0 direction").
- `MemoryFrontmatter.vitest.ts:26-27` keeps the raw text on unreadable
  frontmatter. That is data preservation. The comment's "(back-compat with
  the old parser)" cites a parser that no longer exists. It is a wording fix
  for lens 3 or lens 5, not a compat path.
- The crash project is apart from the edit loops, and its exclusion is by
  project name: `src/test-kernel/AGENTS.md` "Scoping the test run" and the
  round-4 X report's R9.
- `sessionEvents.vitest.ts`'s mocks: `2026-11-04-store-and-test-support-debts.md`
  C7. `crashConformance.ts` re-implementing `storeFaults.ts`: C4 there.
- Platform skips in the e2e specs: each states its platform fact. The
  desktop job runs on macOS on purpose (`ci.yml:376-386`).
