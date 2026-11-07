# Round 5, lens 2: production code that exists for tests

Base: `main` at `c9ceb23`. Read-only audit. Flags and format: round 2's
BRIEF, read through `AGENTS.md` "Testing discipline" and
`src/test-kernel/AGENTS.md`. Paths are repo-relative.

**Method.**

- Exports: every `export` in `packages/*/src` (declarations and `export { }`
  lists), with the files that import the name in an `import { … } from`
  clause, a dynamic `import()` or a `vi.mock`. A name is "test-only" when no
  production file other than its own imports it and at least one test file
  does.
- Public entries: the names each of the six harness entry files exports,
  with their importers outside `packages/harness/src` by specifier.
- Options and knobs: `"for tests"` / `"a test's"` / `"stand-in"` comments in
  production, the options the test kernel passes to `processLayer`, every
  `TEXRA_*` variable production reads (who sets it), every
  `Context.Reference` (who provides it), and the `?:` fields of the CLI and
  desktop entry inits, each checked by hand against its callers.

Scripts: `/tmp/claude-0/-home-user-TeXRA/282a79e8-4cfa-59b7-ad57-f935b38bcc7e/scratchpad/exports4.py`
and `pub.py`. A regex import scan misses namespace imports (`import * as`).
I checked each name below by hand, and dropped one name the scan reported
(`buildClaudeAgentEnv`, which `claudeAgent.ts:515-516` calls as
`config.buildClaudeAgentEnv()`).

## Numbers

- **Exports with only test importers:** 24 after the hand check (9 values,
  15 types) out of all `packages/*/src` exports. The tree is already well
  pruned: the docgen API reports and the earlier rounds took most of them.
  The values are `runHeadlessAgent`, `validationModel`, `DESKTOP_PROJECTS`,
  `STORE_HELD_MESSAGE`, `LocalRuntimeStateSchema`, `judgeFailure`,
  `injectStandaloneTrace`, `GitCloneFailed`, `GitHubRateLimitError` and
  `BashRequestPanel`. Each is used in its own file, so the export is the only
  test-facing part.
- **Harness public entries:** 207 names have no production importer outside
  the harness. 22 of them have test importers only, and 185 have none.
  Round 3's Q reported these counts (`Q-public-surface.md` table and (c)); this
  report adds only the names Q did not list.
- **`processLayer` options only tests pass:** 2 of the 12 fields of
  `ProcessServicesOptions` (`processStart`, `toolAvailability`), both on the
  public API report (`packages/harness/docs/api/host.md:1809,1837`).
- **Environment switches production reads that only tests or scripts set:**
  - `TEXRA_DESKTOP_E2E_USER_DATA_PATH`: 2 modules.
  - `TEXRA_DESKTOP_HEADLESS`: 6 modules, 16 references outside its definition.
  - `VITEST`: 1, settled.
  - `TEXRA_INTERNAL_VALIDATE_*` / `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL`:
    found (K-cli).
- **`Context.Reference`s only tests set:** 0. All 14 are provided in
  production (`HostSkillSources` is set by tests and by `processLayer.ts:274`).
- **Production comments that cite a test:** 14. Three of them cite a test
  that does not exist (finding 5).

## Findings

### 1. `processLayer` takes two options that only the test kernel passes, one of which does nothing a cache does not already do

**Red flags:** an option for a special case (a knob only tests turn) on the
public SDK surface; two representations of one fact (the process's start
identity is both memoized and injected).

**Evidence.**

- `ProcessServicesOptions` (`packages/harness/src/controllers/session/sessionLayer.ts:291-345`)
  has 12 fields. Two of them have one caller, the test kernel:
  - `processStart?` (`:294-298`), defaulting to
    `nodeProcesses.selfIdentity()` (`:355`). The kernel passes
    `processStart: Effect.succeed('vitest')`
    (`src/test-kernel/support/testKernel.ts:248`).
  - `toolAvailability?` (`:320-322`), whose comment says "a test harness
    passes one that starts no probe". It defaults to `toolAvailabilityLayer`
    (`:362`). The kernel passes `unprobedToolAvailability`
    (`testKernel.ts:242`; `src/test-kernel/support/toolAvailabilityTestLayer.ts:8-25`).
- The production callers pass neither (0 of 2): `texraProcessLayer`
  (`packages/texra/src/controllers/texraProcessLayer.ts:97-134`) and
  `Sessions.layer` (`packages/harness/src/effect/processLayer.ts:160-176`).
- Both options are on the published reference
  (`packages/harness/docs/api/host.md:1809,1837`,
  `config/api-reports/harness.host.api.md:112`), so embedders are offered two
  knobs that exist for the repository's own suites.
- `processStart` buys nothing. `selfIdentity` is already memoized for the
  whole OS process (`packages/harness/src/platform/defaults/nodeProcesses.ts:213-235`,
  "`let selfIdentity`" and "memoized once read"). Every process the kernel
  builds in a worker therefore reads `/proc` (or `ps`) once at most. No suite
  or support module reads the `'vitest'` owner string: a grep of
  `src/test-kernel` and `packages/*/test` for `'vitest'` owner use and for
  `processOwnerId` finds only suites that build their own `ProcessIdentity`
  layer.
- `toolAvailability` is load-bearing. The real probes spawn the CLIs they
  look for on every session open, and their answer depends on what the
  developer's machine has installed. The stub keeps the tool gate
  machine-independent. Its other capability, "until a suite sets results on
  `results`" (`toolAvailabilityTestLayer.ts:11`), has no user: no suite
  imports `ToolAvailability` from the kernel's runtime. The one suite that
  tests availability (`src/test-kernel/tools/ToolAvailabilityAppSignals.vitest.ts`)
  builds the real layer itself.
- Churn: `sessionLayer.ts` and `testKernel.ts` 6 `simplify`/`refactor` commits
  each since 11-05 (my count). Both files are in E's open #14829 (R3-E2),
  which edits `ProcessServicesOptions.secrets` and the kernel's
  `PROCESS_SERVICES`. **Sequence after #14829; owner E.**

**The design decision behind it.** The composition builds every Node
service itself (`nodePlatformServices`, `sessionLayer.ts:405-413`), so a test
cannot fake anything at the edge, and every fake has to come in as an option.

**The better design.**

- Delete `processStart`: the field, its default destructure, its JSDoc,
  the kernel's line and the `host.md` and API-report entries. The process
  identity is a fact of the OS process, and its owner, `nodeProcesses`,
  already caches it.
- `toolAvailability`: keep it, as the one deliberate test seam it is, or
  move the fake to the edge the probes cross. The edge is the PATH the
  probes' spawner searches: give the kernel's host an empty command
  directory, so every probe answers "not installed" quickly, and let a suite
  that needs a tool put a fake on PATH, as `LeanServerPool.vitest.ts`
  already writes a fake `lake`. That runs the real probe code in every
  kernel suite, at the cost of a spawn per probed plugin per session open
  (unverified: not measured). If the seam stays, its doc and its stub's
  comment should say "test kernel only" and drop the unused "sets results"
  capability.
- Callers afterwards: hosts as today; the kernel passes one option fewer.

**What we give up.** Nothing for `processStart`. The kernel's rows carry the
real start string instead of `'vitest'`, and nothing reads it. For
`toolAvailability`, moving to PATH changes which tools a kernel suite sees
unless the suite puts the CLIs it needs on PATH. That is the real risk, and
it is why "keep, labelled" is a fair outcome.

**Change amplification.** Take "an embedder reads the process options to
build its own host". Today it meets 12 fields, 2 of which are test seams the
docs present as options. After: 11, with 1 labelled.

**Depends on:** #14829 landing (same two files). Otherwise none.

---

### 2. The desktop's E2E switches make 9 of 11 Playwright specs run the app's fallback path, and six modules read a headless flag

**Red flags:** an environment switch for tests read in production; special
and general code mixed (a data-root branch for E2E); information leakage (one
variable read in two modules, with a unit test of the switch itself).

**Evidence.**

- `TEXRA_DESKTOP_E2E_USER_DATA_PATH` is read twice in production:
  - `packages/desktop/src/main/bootstrap.ts:11-17` moves Electron's
    `userData` to it ("Playwright tests need a deterministic Electron
    profile");
  - `packages/desktop/src/main/platform/paths.ts:16-41` (`resolveDesktopDataRoot`)
    then makes the data root that profile instead of `~/.texra` whenever the
    variable is set.
- The background service refuses any data root that is not
  `defaultNodeStorageRoot()` (`packages/desktop/src/main/desktopService.ts:29-45`:
  "a profile kept elsewhere (a test's) runs its tasks in the app"). On that
  refusal the app falls back to running tasks in-process and logs a warning
  (`packages/desktop/src/main/index.ts:142-152`).
- `launchTexraApp` always sets the variable to a fresh `mkdtemp`
  (`packages/desktop/tests/e2e/electronApp.ts:112-126`). Only two specs
  instead point it at `<home>/.texra` with `HOME: home`:
  `serviceClient.spec.ts:45,70-72` and `proposalEdit.spec.ts:164-170`. The
  other 9 of the 11 launching specs (`agentCatalog`, `devStartup`,
  `menuLifetime`, `screenshots`, `sessionLifecycle`, `settingsPersistence`,
  `stateStoreStartup`, `trajectories`, `workspaceTabs`; 20 launches) run the "TeXRA runs this app's tasks here only" fallback, which
  production reaches only when the service fails. They also inherit the
  developer's real `HOME` (`electronApp.ts:122`, `...process.env`).
- The switch has its own unit test, which tests test plumbing:
  `packages/desktop/test/desktop/ElectronCompositionRoot.vitest.ts:9-28`.
  So does the smoke environment builder
  (`src/test-kernel/scripts/DesktopPackageSmoke.vitest.ts:29`). The packaged
  smoke already sets `HOME` to an isolation profile (`:33`).
- `TEXRA_DESKTOP_HEADLESS` is read at module scope from `process.env`
  (`packages/desktop/src/main/desktopPresentation.ts:2`, not through
  `Config`) and branched on in 6 modules with 16 references: `index.ts:39`,
  `desktopBrowserWindow.ts:31-83` (7), `desktopWindows.ts:228`,
  `desktopAttention.ts:60,63`, `fatalStartupError.ts:50`. Only
  `electronApp.ts:132` sets it.
- Churn is low (1 commit each since 11-05), so this is cheap to change now.

**The design decision behind it.** "Where does this launch keep its data?"
is answered by an E2E variable instead of by the home directory every other
host and the service already use. Then "may this app use the service?" is
answered by comparing the two.

**The better design.**

- Isolate E2E launches the way the CLI and the service spec already do: set
  a temp `HOME` (and the XDG and profile keys `scripts/isolated-home.mjs`
  lists) in `launchTexraApp` for every spec.
- Delete `resolveDesktopDataRoot`'s branch, so the data root is always
  `defaultNodeStorageRoot()`, and delete `ElectronCompositionRoot.vitest.ts`.
- The `dataRoot !== defaultNodeStorageRoot()` refusal in
  `reachDesktopService` can then go too, since the data root is no longer a
  separate fact.
- `bootstrap.ts`'s `userData` move stays only if Electron's profile does
  not follow `HOME` on a platform (unverified for macOS, where Electron
  resolves `~/Library/Application Support` itself). If it does follow
  `HOME`, delete it as well.
- Headless: one `DesktopPresentation` value, read once through `Config` at
  the composition root and passed to the window factory, instead of a
  module-level constant that six modules import. Two of its uses (window
  options, badge and notification suppression) are a real "automation mode";
  the rest follow from it.
- Every E2E spec then exercises the service path production takes, and the
  fallback keeps one dedicated spec if it deserves one.

**What we give up.** E2E specs start a background service per launch, which
costs a process and its startup (unverified). A spec that needs the fallback
must now break the service on purpose. The README's "Saved keys" paragraph
(`packages/desktop/tests/e2e/README.md:69-73`) changes to say `HOME`.

**Change amplification.** Take "a fourth thing the desktop stores per
profile". Today it lands under whichever root the E2E variable selects, and
a spec author must know that the service is off unless `HOME` and
`userDataPath` agree (2 specs do this by hand). After: one root, with no
branch.

**Depends on:** none. It borders lens 5 F7 (the hand-written e2e lifetime
blocks); land it in the same `launchTexraApp` change.

---

### 3. The CLI's context and input expansion take injection options that only tests pass, beside a guard every caller turns on

**Red flags:** an option for a special case (three test-only inputs and one
boolean constant across its callers); a reinvented host primitive (stdin and
TTY facts read from `process` globals where Effect's `Stdio` exists).

**Evidence.**

- `BuildCliContextInit` (`packages/cli/src/runtime/platform/cliContext.ts:360-369`)
  has `ambient?` and `storageRoot?`. The JSDoc says: "Production leaves this
  unset (`~/.texra`); tests point it at a scratch directory".
  - The one production caller passes neither
    (`packages/cli/src/commands/_helpers/context.ts:24-26`).
  - The only other caller is `src/test-kernel/cli/CliContext.vitest.ts:38-45`
    (13 `storageRoot` and 7 `ambient` references). The type is exported only
    for that test.
  - The home isolation every project's setup runs already points `~/.texra`
    at a per-worker temp home (`vitest.config.mjs:157-160`,
    `src/test-kernel/support/isolateHome.ts:1-12`), so the stated reason
    ("the developer's own … config cannot decide an assertion") is already
    covered. What the option still buys is a per-test root inside one worker.
  - `readCliAmbientState` reads `process.stdin.isTTY`, `process.env.CI` and
    `process.env.TERM` directly and caches them in a module slot
    (`cliContext.ts:191-209`). That is why tests need `ambient?` to change
    them.
- `expandRunInputs` (`packages/cli/src/runtime/headless/workflowInputs.ts:298-307`)
  takes `readStdinText?` ("Where `-` reads from; a test hands in its own
  text"), defaulting to `readProcessStdinText` (`:75-84`, `:324`). Its one
  setter is `src/test-kernel/cli/WorkflowInputsLifecycle.vitest.ts:47`.
- `requireWorkspaceFiles?` (`:304`) is `true` at both production callers
  (`packages/cli/src/commands/team.ts:184`,
  `packages/cli/src/commands/workflow.ts:293`). Only the lifecycle test
  reaches the unguarded path, and it does so with `['-']`, stdin, so the
  path check never runs. The guard's off state has no caller.

**The design decision behind it.** The CLI reads its terminal and stdin
facts from `process` globals, so a test can only replace them through an
argument.

**The better design.**

- Read stdin and the TTY facts through Effect's `Stdio`
  (`node_modules/effect/dist/Stdio.d.ts`: `stdin` as a byte `Stream`,
  `stdinIsTerminal`, `stdoutIsTerminal`, `stderrIsTerminal`; `NodeStdio` in
  `@effect/platform-node`), and `CI` / `TERM` through the ambient
  `ConfigProvider` the CLI already uses for its env tier (`envTier`,
  `cliContext.ts:371-376`).
- Tests provide `Stdio.layerTest({...})` (`Stdio.d.ts:151`) and `withEnv`,
  which they already use. Delete `readStdinText?`, `ambient?` and the
  `cachedAmbient` module slot.
- Make `storageRoot` follow `HOME` alone. Tests that need a user-level file
  write it under the worker's isolated home and remove it in their
  finalizer, or set `HOME` for the case. Delete `storageRoot?` and the
  `BuildCliContextInit` export.
- Delete `requireWorkspaceFiles` (the field, `WorkflowInputExpansionOptions`'
  copy at `:65`, the `shared` object at `:323`, and the `=== true` test at
  `:48`): the guard always holds.
- Callers write `buildCliContext({ globalArgs })` and
  `withExpandedRunInputs(inputs, context, cwd, { allowEmptyInput }, run)`.

**What we give up.** A test of the user-level config layer can no longer
make a fresh root per case inside one worker. It must clean up what it
writes under the shared temp home (`rule of three` helper in the suite).
`Stdio` is marked `@stability unstable` in effect 4.

**Change amplification.** Take "add a fourth ambient fact, e.g.
`NO_COLOR`". Today: `CliAmbientState`, `readCliAmbientState`, the cache, and
every test's hand-built `ambient` object (`CliContext.vitest.ts:20-29`), so
3 places plus fixtures. After: one `Config` read, and tests use `withEnv`.

**Depends on:** none. `CliContext.vitest.ts` had 3 refactor commits since
11-05. Not in an open PR.

---

### 4. Lean's `lakeCommand` is threaded through three modules so one test can swap the binary

**Red flags:** an option for a special case (a parameter that is constant
per caller); pass-through (two modules only forward it).

**Evidence.**

- The one production value is `'lake'`
  (`packages/texra/src/tools/lean/plugin.ts:89`,
  `directLeanLanguageServices('lake')`).
- The parameter is passed or forwarded at:
  - `directLeanLanguageServices(lakeCommand)` and `make(lakeCommand)`
    (`packages/texra/src/tools/lean/direct/leanServerPool.ts:115-133`; the
    JSDoc reads "`lake`, or a test's stand-in");
  - `LeanServer.layer({ lakeCommand })` (`:133`), and on to
    `ChildProcess.make(lakeCommand, …)` (`leanServer.ts:145,265,280`);
  - `runLakeCommand({ lakeCommand })` (`leanServerPool.ts:254`, then
    `lakeCommands.ts:48,84,108`).
- Its other callers are tests:
  - `src/test-kernel/tools/lean/LeanServerPool.vitest.ts:169` passes
    `fakeLakePath`, an executable script it writes at `:142-144`;
  - `src/test-kernel/tools/lean/LeanTools.vitest.ts:73,81` pass
    `process.execPath` to `runLakeCommand`.
- The pool suite already provides its own spawner (`spawnerLayer`, `:169`)
  and already stubs the environment (`vi.stubEnv`, `:146-147`). The fake
  could be found by name.

**The design decision behind it.** The binary's name is a constant, and the
test fakes it by changing the argument instead of changing what the name
resolves to.

**The better design.** Delete the parameter: 4 signatures and 3 forwarding
sites. `leanServer` and `lakeCommands` spawn `'lake'` themselves. Each suite
writes its fake as `lake` in a temp directory and prepends that directory to
`PATH` (`vi.stubEnv('PATH', …)`, as it already stubs two variables). The
lifecycle suite writes a two-line `lake` that execs node instead of passing
`process.execPath`. The tests then exercise the real PATH lookup the probe
(`plugin.ts:70`: "`lake` on PATH") relies on.

**What we give up.** The fake is a shell-resolvable file, POSIX only. The
pool suite is already POSIX-gated (`LeanServerPool.vitest.ts:213`, per lens
6's numbers), and `LeanTools` would need the same gate or a `.cmd` shim
(unverified on Windows).

**Change amplification.** Take "spawn `lake` with one more flag". Today you
read past a parameter that three modules carry. After: one call site per
module.

**Depends on:** none. The suites had 1 commit each since 11-05. It borders
lens 4's LeanServerPool timing items; land them separately.

---

### 5. Three production comments promise a test that does not exist, and the facts they guard are duplicated

**Red flags:** comments substituting for design (a comment claims protection
in place of one owner); two representations of one fact; a false comment.

**Evidence.**

- `packages/cli/src/chat/tui/input/textInputBindings.ts:10-13`: "The audit
  in TextInputBindings.vitest.mts probes every chord and fails on shadowed
  or unreachable entries." No such file exists (`find -iname '*textinput*'`
  finds four production files and no test), and no suite imports
  `textInputBindings`. The precedence the comment calls load-bearing
  ("earlier entries win, so modified chords … must precede their unmodified
  bases", `:10-11`) is unguarded.
- `packages/texra/src/shared/agentCliSettings.ts:77-78`: "The reasoning
  policy's `DEFAULT_EFFORT` (a test holds them equal)" over
  `AGENT_CLI_EFFORT_DEFAULT = ReasoningEffort.MEDIUM`. The policy's constant
  is `packages/llm/src/models/reasoningChoice.ts:23`, file-local. No test
  imports `agentCliSettings` or compares the two (grep of `src/test-kernel`
  and `packages/*/test`).
- `agentCliSettings.ts:55-59`: `CODEX_DEFAULT_MODEL = 'openai/gpt-6.1-sol'`,
  "a test holds this to the picker". No test references it. The default goes
  through `withDecodingDefault` into a schema built from the picker
  (`:47`, `:54`, `:89`), so when llm-zoo drops that model the setting's
  absent-field decode fails at run time, with no test to fail first.
- The comments that cite a test that does exist check out:
  `defaultModels.ts:24`, `setupModelDefaults.ts:7`, `rowVersions.ts:21`,
  `protocol.ts:400` and `runState.ts:572`
  (`sessionViewUpdate.vitest.ts:346,420`).

**The design decision behind it.** A copied constant is held in sync by a
promised test instead of by importing its owner.

**The better design.**

- Effort: export `DEFAULT_EFFORT` from `@texra-ai/llm` (it is the policy's
  own fact) and import it. Delete `AGENT_CLI_EFFORT_DEFAULT` and its comment.
- Codex default: derive it from the picker if llm-zoo's order is newest
  first (unverified), or keep the literal and write the one test the comment
  promises. That test protects a real contract, a decode that fails for
  every user on a zoo bump, under rule 3's "boundary sizes / bad input" list.
- Bindings: either write the shadowing audit, a property over the table
  that a later entry is reachable for some input, or delete the sentence.
  Since the table claims to be the single source for `/help` too, the audit
  earns its place.

**What we give up.** Nothing. One export added to llm's index (its API
report changes).

**Change amplification.** Take "change the default effort". Today: 2 files,
and the comment says a test will catch a miss, but none will. After: 1.

**Depends on:** none.

---

### 6. Batched: exports and shapes that exist only for a test

| Symbol / site                                                                                                                                                                                                                                                                                                                                                                 | Consumers (src, tests)                                                                                                                                    | Note and fix                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeXmlEntities` on `@texra-ai/harness/transcript` (`packages/harness/src/transcriptEntry.ts:137-140`, defined `shared/subagentFollowup.ts:93`)                                                                                                                                                                                                                            | 0, 1 (`packages/harness/test/cli/SubagentFollowup.vitest.ts:3`)                                                                                           | A public value with only a test importer. Not in Q's (c) list. Drop it from the entry; the suite tests it through `summarizeEmbeddedSubagentFollowups`, the public reader that calls it (`:151`).                                                                                                                                                                          |
| `runHeadlessAgent`, `CliConfigExecuteResult` (`packages/cli/src/commands/workflow.ts:123`, `runtime/headless/executeCli.ts:92`)                                                                                                                                                                                                                                               | 0, 1 (`src/test-kernel/cli/WorkflowRunCommand.vitest.ts:16,112-115`)                                                                                      | Exported for a suite that `vi.mock`s three CLI modules around it (`:82-107`). Lens 1 §1.2 moves that suite to the CLI's output. Un-export both in the same PR (6 refactor commits since 11-05).                                                                                                                                                                            |
| `judgeFailure` (`packages/llm/src/api/verdict.ts:337`)                                                                                                                                                                                                                                                                                                                        | 0, 2 (by relative path into `llm/src`: `src/test-kernel/agent/runtime/RetryState.vitest.ts:87`, `packages/harness/test/common/SdkErrorUtils.vitest.ts:9`) | Its production caller is `judgedModel` in the same file (`:365-372`), the public boundary. Lens 1 §1.1 owns the suites (RetryState is rank 1 churn). Make it file-local once they go through `judgedModel`.                                                                                                                                                                |
| `processLayer`'s `SessionOwner` leak (`packages/harness/src/effect/processLayer.ts:268`, `provideMerge`)                                                                                                                                                                                                                                                                      | 0 outside the harness, 4 test files                                                                                                                       | The runtime serves the internal owner beside `Sessions` because `provideMerge` passes it through, and the kernel reads it with a cast (`testKernel.ts:224-226`: "the process layer provides `SessionOwner`, which its type omits"). This is lens 1's subject (root launches past `session.start`). Noted here because production's type and value disagree only for tests. |
| `isElementFrom` (`packages/desktop/src/renderer/desktopShortcutRegistry.ts:92-101`)                                                                                                                                                                                                                                                                                           | 2 sites                                                                                                                                                   | "tests install a separate DOM", so `instanceof` goes through `view.Element`. The renderer has one realm. Small; leave it unless the suite moves to the app's own DOM (lens 6's isolated tier).                                                                                                                                                                             |
| Type-only exports for fixtures: `RunRegistryInit`, `RunPrograms` (`agent/runtime/runRegistry.ts:66,99`), `ResumeRunOptions` (`resumeRun.ts:58`), `InboxPort` (`followUp/Inbox.ts:41`), `SessionViewUpdater` (`shared/session/sessionViewUpdate.ts:81`), `ChatSessionControllerInit` (`packages/cli/src/chat/chatSessionController.ts:189`), `BuildCliContextInit` (finding 3) | 0, 1-2 each                                                                                                                                               | Each is the parameter type of a production function that a suite or support builder calls directly. They go away with lens 1's moves to stable boundaries, not on their own. A type export is cheap; no separate PR.                                                                                                                                                       |

Left as they are, with the reason:

- `GitCloneFailed`, `GitHubRateLimitError`: typed errors are part of their
  module's error channel, and tests constructing them is fine.
- `injectStandaloneTrace`: a pure transform over a template marker, which is
  a durable boundary.
- `STORE_HELD_MESSAGE`: documented in `packages/harness/README.md:367`. Lens
  3 may flag the test that reuses it as its own expected value.
- `DESKTOP_PROJECTS` / `TEXRA_SERVICE`: the release watermark suite lists
  every value family by owner (`src/test-kernel/schemas/rowVersions.vitest.ts:53-61`),
  a deliberate registry checked against the tree.

**Depends on:** lens 1 §1.1 and §1.2 for the CLI and llm rows; none for
`decodeXmlEntities`.

## Good modules in this area

- `nodeProcesses.selfIdentity` (`packages/harness/src/platform/defaults/nodeProcesses.ts:213-235`):
  it memoizes a process constant at its owner and retries until the first
  read succeeds. That memo is what makes finding 1's option redundant.
- `jitteredExponentialBackoffMs` (`packages/harness/src/utils/core/index.ts:78-96`)
  takes its random draw from the caller (`yield* Random.next`), so tests fix
  the jitter through Effect's `Random` rather than an option or a stub of
  `Math.random`. Copy this for any randomness.
- `SessionFramer` (`packages/texra/src/controllers/session/SessionFramer.ts:81`)
  is pure over its source, so a test drives it with a stream and no knob.
- `workflowOutput.ts`'s probe (`packages/cli/src/runtime/headless/workflowOutput.ts:90-120`)
  reads `Path` from the context, so a Windows-path test provides
  `NodePath.layerWin32`: a real service swap, not an option.
- `auth-bridge` and `github-app-token-exchange`
  (`supabase/functions/auth-bridge/index.ts:106,148`,
  `supabase/functions/github-app-token-exchange/index.ts:51,130`) export the
  handler and serve under `import.meta.main`, so their suites call the real
  handler. Lens 5 F8 is about the two that do not.

## Already settled, left alone

- `checkRecordedRequest` under `VITEST`
  (`packages/harness/src/agent/runtime/run/requestContext.ts:322-331`): a
  development invariant check, settled in
  `2026-11-05-design-red-flags/D-model-call.md:653`.
- `validationModel.ts`, `validationSwitch.ts` and the
  `TEXRA_INTERNAL_VALIDATE_*` / `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL`
  switches: test fixture scripts in the production tree,
  `2026-11-06-design-red-flags-round-2/K-cli.md:835`. Also cited in
  `R-test-infrastructure.md`'s settled list. `ValidationModel` as a route
  kind: `D-model-call.md:657`.
- `UsageLogConfig`'s `enabled` and cadence knob, the test-only part of the
  usage log: `2026-11-07-design-red-flags-round-4/Y-added-today.md:319-370`.
- `sessionStoreFaults` assigning over the shared `Database`, since a
  production injection option would be a knob for tests:
  `R-test-infrastructure.md:678-682`.
- The renderer's reachability fallback for tests (N5) and the dispatcher's
  test-mode switch (J6): `2026-11-07-design-red-flags-lenses/catalogue.md:574,606`.
- `applyReplacements` exported for tests only (I12): `catalogue.md:365`.
- The harness public surface's test-only and unconsumed names, and
  `LocalRuntimeStateSchema` among the wire leaves:
  `2026-11-07-design-red-flags-round-3/Q-public-surface.md:640-656` and its
  entry table.
- `cliInitPlatformMock` (`K-cli.md:383`) and `prPollingSourceState`
  (`H-app-tools.md:232`): cited by R's settled list.
- The settings frontend's `resetSettingsState` on construction
  (`packages/extension/src/settingsView/frontend/SettingsApp.ts:59-64`): the
  comment says "tests, hot reload", but the desktop remounts the element in a
  live shell window (`:72-73`), so the reset is a production need.
- The llm transports' `fetch?` (`packages/llm/src/api/openaiResponses.ts:72`,
  `anthropicMessages.ts:573`): production passes the harness's bound model
  fetch (`packages/harness/src/agent/runtime/modelAccess/binding.ts:168`).
  This is not test-only.
