# RT: root tooling, test support and CI (2026-11-15)

Read on `main` at `d70ad92` (the checkout is `acecefcbf3`, which differs from
`d70ad92` only in this folder's reports). Scope: `scripts/`,
`src/test-kernel/` and the other repo-root `src/` suites, `packages/*/test`
support, `oxlint.config.mts`, build and CI config, `.github/workflows/`.

## Numbers

| Directory                        | Lines (ts, mjs, cjs, js, yml) |
| -------------------------------- | ----------------------------: |
| `scripts/`                       |                          5087 |
| `src/test-kernel/` (all)         |                         19671 |
| `src/test-kernel/support/`       |                          4942 |
| `.github/workflows/` and actions |                          2054 |
| `oxlint.config.mts`              |                           402 |
| `vitest.config.mjs`              |                           302 |

Five largest files: `scripts/verify-desktop.mjs` (1528),
`src/test-kernel/support/crashConformance.ts` (1238),
`src/test-kernel/support/storeFaults.ts` (624),
`scripts/check-guidance-refs.mjs` (585), `.github/workflows/ci.yml` (559).

Rounds 3 (S, R) and 5 (tests) audited this area closely; S1 to S9, RT1 to
RT8 and R5-1 to R5-15 have landed or are held. This round reads what is
left after them.

## RT-1: Four scripts stop a test home's background services, each re-reading the socket name and log line by hand

- flags: information leakage, repetition
- package: root (touches `packages/cli/scripts`, `packages/desktop/tests/e2e`)
- kind: refactor
- size: M
- earlier: none
- open PR: none

**Evidence.** The service's file grammar has one production owner:
`packages/texra/src/controllers/server/discovery.ts:50-51`
(`SOCKET_NAME = /^serve-(\d+)\.sock$/`, `socketName`), `:63` (`run/serve.log`),
`:263` (`processAlive`), and the log line
`packages/texra/src/controllers/server/serve.ts:252`
(`` `TeXRA service ${BUILD_VERSION} listening on ${socket}` ``). Four test
scripts restate it and each writes its own "signal, then poll until gone":

- `scripts/desktop-package-smoke-environment.mjs:155-197`: `alive`
  (`process.kill(pid, 0)`), `servicePids` with the socket regex copied at
  `:170`, `stopServices` with a 100 ms poll up to 30 s (`:190-196`).
- `scripts/vscode-host-e2e-runner.mjs:153-202`: `servicePid` hard-codes
  `.texra/run/serve.log` (`:158`) and the log regex
  `/listening on \S*serve-(\d+)\.sock/` (`:161`); `:136` and `:189-200` are
  two more `process.kill(pid, 0)` probes and a 15 s poll.
- `scripts/vscode-host-e2e-suite.cjs:110`: the full log line again,
  `/TeXRA service (\S+) listening on \S*serve-(\d+)\.sock/g`, with its own
  60 s `until` poll (`:113-118`).
- `packages/cli/scripts/validate-run.mjs:1146-1213` (`removeScratch`): `find
  … -path '*/.texra/run/serve.log'` (`:1156-1159`), the log regex
  (`:1168`), a third `signal` helper, a `ps` probe and an `Atomics.wait`
  poll with SIGKILL after 10 s.

`alive` has 2 e2e consumers (`serviceClient.spec.ts:112,114`);
`servicePids`/`stopServices` 3 (`electronApp.ts:54,247`,
`sessionLifecycle.spec.ts:134`).

**The design decision behind it.** "Which TeXRA services did this home
start, and how do I stop them and wait?" is answered in four places, each
deciding the socket name, the log path, the log line and the wait budget
again. A rename of `serve-<pid>.sock`, of `serve.log` or of the "listening
on" wording breaks three validation scripts and the desktop e2e cleanup with
no compiler or test pointing at them; the vscode runner and validate-run
would then fail open (no pid found, nothing stopped, a leaked service).

**The better design.** One script module beside
`desktop-package-smoke-environment.mjs` (or that file itself) owns the
service grammar for scripts: `servicePids(dataRoot)` (socket directory listing
through the bundled production `servicePaths`, which already handles the
long-root `/tmp` fallback that validate-run re-derives from the log),
`serviceAnnouncements(log)` (the one log-line regex, with the version the
VS Code suite checks), and `stopServices(dataRoot, { timeoutMs })`. The
vscode runner and validate-run call `stopServices(home/.texra)`; the suite
reads `serviceAnnouncements`. Deleted: `servicePid` and `stopService` in the
runner, `removeScratch`'s socket/log parsing and `signal`/`running`/`pause`
helpers, three `process.kill(pid, 0)` probes. Better still, export a
`livePids(paths)` from `discovery.ts` that `removeDeadSockets` (`:235-256`)
also uses, so the scripts' bundle calls the production reader and the regex
lives once.

**What we give up, and risk.** validate-run's cleanup is synchronous (it
runs from a process `exit` path, hence `Atomics.wait`); `stopServices` would
need a sync variant or validate-run would stop services before exit rather
than in the hook. The `.cjs` suite runs inside VS Code's extension host and
cannot import an ESM module synchronously; it would keep the one regex or
`await import()` it.

**How I tried to refute it.** Checked whether the copies differ on purpose:
the runner reads the log because a window starts the service (no pid
otherwise), but the socket directory names the same pid; validate-run walks
logs because a scratch dir may hold several homes, which `find` on
`.texra/run` answers equally. The `ps … serve` check in validate-run guards
pid reuse, which none of the other three do, so the shared helper should
take it. No earlier report names these sites (grep for `servicePids`,
`stopServices`, `serve.log`, `listening on` in `.agents/docs/`: only the
architecture note on `serve-<pid>.sock`'s purpose).

## RT-2: The temporary-home launch environment is hand-written at seven launch sites beside the `isolatedHomeEnv` that owns it, each with a different subset of keys and kill switches

- flags: repetition, information leakage, comment restates code
- package: root (touches `packages/cli/scripts`, `packages/desktop/tests/e2e`)
- kind: refactor
- size: M
- earlier: none (round 5's `2-code-for-tests.md:190` pointed the desktop
  e2e at `isolated-home.mjs`; that part landed, the other sites never moved)
- open PR: none

**Evidence.** `scripts/isolated-home.mjs:13-36` owns "which environment
keys a temp home replaces": `HOME_DIRECTORY_KEYS` (8 keys) and
`isolatedHomeEnv(home)`, whose object restates the same 8 keys, and the
hand-written `scripts/isolated-home.d.mts:1-14` restates them a third time.
Its header (`:1-6`) says it is "One list for" the kernel suite, the VS Code
runner and the CLI validation scripts. Consumers that use it:
`isolateHome.ts:40`, `vscode-host-e2e-runner.mjs:114`, `electronApp.ts:200`.
Launch sites that write the keys by hand instead:

| Site                                                                            | Home keys written                        | `TEXRA_NO_TELEMETRY`     | `TEXRA_NO_UPDATE_CHECK`       |
| ------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------ | ----------------------------- |
| `packages/cli/scripts/validate-run.mjs:84-96` (`isolatedCliHomeEnv`, 9 callers) | HOME + 4 XDG                             | one caller of 9 (`:992`) | yes                           |
| `packages/cli/scripts/validate-journeys.mjs:250-258`                            | HOME + 4 XDG                             | no                       | yes                           |
| `packages/cli/scripts/generate-golden-store.mjs:323-337`                        | all 8                                    | yes                      | yes                           |
| `scripts/desktop-package-smoke-environment.mjs:65-76`                           | 7 (no `XDG_DATA_HOME`, `XDG_STATE_HOME`) | no                       | yes                           |
| `packages/desktop/tests/e2e/serviceFixture.ts:76-82`                            | HOME only                                | yes                      | no                            |
| `electronApp.ts:198-203` (uses the helper)                                      | 8                                        | yes                      | no (CI adds it, `ci.yml:419`) |
| `vscode-host-e2e-runner.mjs:113-117` (uses the helper)                          | 8                                        | yes                      | no                            |

The three CLI scripts already call `isolateProcessHome()` from the same
module (`validate-run.mjs:35`, `validate-journeys.mjs:45`,
`generate-golden-store.mjs:126`) and then rebuild the per-run home by hand.

**The design decision behind it.** "What must a test launch of TeXRA be
given so it touches no real profile and phones nothing home?" is decided at
every launch site. The answers have drifted: `serviceFixture.ts`'s `cli()`
moves only `HOME`, so on a machine with `XDG_CONFIG_HOME` or `APPDATA` set
the spawned `texra` resolves those to the developer's real folders (the very
directories `homeIsolationCheck.ts:31-37` treats as off-limits);
`validate-journeys` sends usage telemetry from every journey run unless the
caller exported the opt-out; the desktop e2e relies on a workflow env
(`ci.yml:419`) for a switch its fixture should own. A new home key (say
`XDG_RUNTIME_DIR`) needs seven edits and gets one.

**The better design.** `isolated-home.mjs` exports one
`testLaunchEnv(home)`: `isolatedHomeEnv(home)` plus `TEXRA_NO_TELEMETRY` and
`TEXRA_NO_UPDATE_CHECK`. `HOME_DIRECTORY_KEYS` becomes
`Object.keys(isolatedHomeEnv(''))` (one list), and the `.d.mts` declares
`isolatedHomeEnv` as returning `Record<string, string>` (or the module becomes
JSDoc-typed `.mjs` checked by `allowJs`, deleting the `.d.mts`). Each of the
seven sites spreads `testLaunchEnv(home)` and adds only what is its own
(provider keys, `TZ`, `TEXRA_NO_SERVICE`). Deleted: the four hand-written
key blocks (about 40 lines), `isolatedCliHomeEnv`'s home half, the
`ci.yml:419` env, and the header's list of consumers (a comment that is
already false).

**What we give up, and risk.** The packaged smoke deliberately builds its
environment from an allowlist (`desktop-package-smoke-environment.mjs:10-56`,
so signing secrets never reach the app); it keeps the allowlist and spreads
`testLaunchEnv` on top, which adds the two XDG keys it lacks, a strict
improvement. `DesktopPackageSmoke.vitest.ts` pins only the allowlist and
`HOME`, so it keeps passing.

**How I tried to refute it.** Looked for a reason each site differs: the
golden store needs a deterministic environment (`TZ`, `LANG`, `SHELL`),
which is additive, not a different home; validate-run filters provider keys,
also additive. Desktop's update check runs only when packaged
(`desktopUpdateChecker.ts:69`), so the e2e missing `TEXRA_NO_UPDATE_CHECK`
is harmless today, but the CLI checker has no such guard, which is why the CLI
scripts set it. Grepped `.agents/docs/` for `isolatedHomeEnv`,
`isolatedCliHomeEnv`, `buildDesktopSmokeEnvironment`: no earlier finding.

## RT-3: `verify-desktop.mjs` checks one artifact list twice (the build output and the packaged app), and its pass summaries are hand-kept lists that omit checks

- flags: repetition, comment restates code, non-obvious code
- package: root
- kind: refactor
- size: M
- earlier: none (round 3 listed the stage table and reporter as a good
  module, `S-build-tooling.md:659`; the two stages' overlap was not read)
- open PR: none (#14953, which last edited the file, has merged)

**Evidence.** `scripts/verify-desktop.mjs` already has an app reader that
makes a plain directory look like the package
(`createDirectoryAppReader`, `:744-777`, beside `createAsarAppReader`,
`:660-742`). The `build-artifacts` stage does not use it and re-implements
six of the `package` stage's checks over `dist/` with its own helpers:

| Check                               | `build-artifacts` (`verifyBuildArtifacts`, `:140-208`) | `package` (`verifyPackage`, `:1087-1153`)                   |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| main bundle                         | `:145-147` (from `package.json` `main`)                | `:1111` (literal `dist/main/index.js`)                      |
| preload, renderer HTML              | `:148-149`                                             | `:1112-1113`                                                |
| a `.js` and a `.css` renderer asset | `:166-171`                                             | `:1123-1129`                                                |
| Monaco worker assets                | `:172-182`                                             | `checkMonacoWorkerAssets`, `:1036-1045`                     |
| no runtime `vscode` import          | `:183-190` (main only)                                 | `checkNoVscodeRuntimeImport`, `:784-792` (every main chunk) |

Each stage also brings its own existence probe: `exists` (`access`,
`:70-77`), `fileExists` (`statSync`, `:136-138`), `checkExists`
(`:779-782`). The `vscode` check has already drifted: the build stage reads
only the entry file, the package stage every chunk under `dist/main`.

The pass summaries restate the checks as prose instead of reporting what
ran. `verifyPackage`'s summary (`:1133-1149`) lists 14 lines and omits two
checks the stage makes (`serve/texra-serve.mjs`, `:1028-1033`; the macOS
`node-pty` `spawn-helper` bits, `:1070-1085`) and the `main` field check
(`:1105-1109`); the icon line is spliced in at a hard-coded index
(`summary.splice(7, 0, '- macOS app icon')`, `:1150`), which lands in the
right place only while the list above keeps its order.

**The design decision behind it.** "What must a desktop build contain?" has
two answers, one for `dist/` and one for the package, and "what did this
stage check?" has a third, written by hand.

**The better design.** One list of named checks over the app-reader
interface: `{ name, check(app, failures) }`. `build-artifacts` runs the
shared subset over `createDirectoryAppReader(desktopRoot)`; `package` runs
it plus its package-only checks (runtime dependencies, resources, service
bundle, icon, pty helper, native CLI payloads, startup graph) over the found
app. The summary is the names of the checks that ran. Deleted:
`verifyBuildArtifacts`' body (about 60 lines), `fileExists`, the 14-line
summary literal and its `splice`, one of the two `.js`/`.css` blocks.

**What we give up, and risk.** The build stage's summary listed each
artifact path; the new one lists check names. `checkMacIcon` returns a flag
used only to splice the summary; with named checks it becomes a check that
skips itself off macOS.

**How I tried to refute it.** The build stage runs before packaging
(`desktop-package.yml:116-117`) and catches a broken `desktop:build` early,
which is why it exists; the proposal keeps the stage and only changes what it
runs. The package stage's `findPackagedApp` (`:578-613`) already falls back to
a directory reader when there is no `app.asar`, so the reader is proven over
a plain tree. No earlier finding (grep for `verifyBuildArtifacts`,
`build-artifacts`, `checkMonacoWorkerAssets` in `.agents/docs/`).

## RT-4: The desktop app has two Playwright launch harnesses with two definitions of "ready": the e2e fixture and `verify-desktop`'s packaged smoke

- flags: repetition, information leakage, non-obvious code
- package: root (touches `packages/desktop/tests/e2e`, `.github/workflows/desktop-package.yml`)
- kind: refactor
- size: L
- earlier: none (round 3 named `launchTexraApp` a deep module,
  `R-test-infrastructure.md:663`; the packaged smoke beside it was not read)
- open PR: none

**Evidence.** `scripts/verify-desktop.mjs:1156-1493` (the `smoke-package`
stage, about 340 lines) plus `scripts/smoke-process-utils.mjs` (64 lines,
one consumer) launch the packaged app through `@playwright/test`'s
`_electron`, seed the project with `rememberOpenProject` (`:1241-1255`),
build a home environment (`buildDesktopSmokeEnvironment`, `:1408`), wait for
readiness, close with a hand-written SIGTERM/SIGKILL ladder
(`closeApplication`, `:1341-1380`; `stopChild`,
`smoke-process-utils.mjs:43-63`) and stop the services (`:1461`).
`packages/desktop/tests/e2e/electronApp.ts:170-262` (`launchTexraApp`) and
`:289-312` (`closeTexraApp`) do the same for the dev build: the same
`rememberOpenProject`, `isolatedHomeEnv`, `stopServices`.

The two disagree on what "the app is ready" means:

- the e2e fixture waits on the flag the renderer publishes,
  `document.body.dataset.desktopReady === 'true'`
  (`electronApp.ts:240-244`; set at `packages/desktop/src/renderer/main.ts:911`),
  then for the service (`:247-251`);
- the packaged smoke polls the renderer's markup: `main#app` with client
  rects and visibility, `progress-app[data-desktop-view="progress"]` with a
  populated shadow root, `.shell-project-workbench[data-session]`, and
  `body.dataset.vscodeThemeKind` (`verify-desktop.mjs:1303-1335`), class names
  and attributes owned by `main.ts:517-518` and the progress view. Its comment
  (`:1305-1307`) records that an earlier selector (`.desktop-shell`) "could
  never resolve", the failure mode of reading markup instead of a published
  signal.

Each also decides the executable path apart: the workflow matrix
(`desktop-package.yml:65,74,82`) and `defaultPackagedExecutables`
(`verify-desktop.mjs:1192-1209`) both spell `dist-packaged/<os dir>/TeXRA…`,
which `electron-builder.yml:2,17,79` owns.

**The design decision behind it.** "How does a test launch TeXRA desktop,
know it is up, and shut it down?" is answered twice, once per build kind. A
renderer markup change breaks only the packaged smoke, which runs only in the
installer workflow (`desktop-package.yml`, dispatched for releases), so it
fails at release time.

**The better design.** One launcher. `launchTexraApp` takes what to launch
(the dev `MAIN_ENTRY`, or a packaged `executablePath` from an environment
variable the workflow sets from its matrix row) and the environment policy
(the dev suite spreads `process.env`; the packaged run keeps the allowlist
from `desktop-package-smoke-environment.mjs:10-56`). Readiness is the
renderer's published flag; if the packaged check needs "a project opened",
the renderer publishes that too (a `data-project-ready` set where the
workbench mounts), and both runs wait on it. The packaged smoke becomes one
spec in a `packaged` Playwright project (`playwright.config.ts:24-31` already
has three projects) asserting `app.isPackaged` and the project. Deleted: the
`smoke-package` stage (about 340 lines), `smoke-process-utils.mjs`,
`defaultPackagedExecutables`, the markup readiness poll.

**What we give up, and risk.** The packaged smoke currently reports one
labelled failure with bounded diagnostics (`appendDiagnostic`, `:1164-1172`);
a Playwright spec reports through its own reporter and `test-results/`
artifacts. The Linux row needs `xvfb-run` around `playwright test` instead of
around `node`. The workflow must install the desktop package's Playwright
(it already does for Linux, `desktop-package.yml:107-108`).

**How I tried to refute it.** Checked whether the smoke's extra conditions
(theme, project workbench) are covered by the e2e flag: they are not, since
`desktopReady` is set synchronously at the end of `main.ts`, before the
project list arrives (`:909-911`), so the packaged smoke checks more. That is
a reason to publish one more flag, not to keep a second harness. Checked the
secrets concern: the allowlist exists because the installer job holds
signing secrets in its environment (`desktop-package.yml:85-98`); the shared
launcher keeps it as a policy argument. No earlier finding (grep for
`smoke-package`, `smokePackagedLaunch`, `waitForReadiness` in
`.agents/docs/`).

## RT-5: The fake host is spread over four support files under three names, `FakeHost` names two types, and its options take three storage paths where production derives two from one

- flags: vague name, information leakage, non-obvious code, shallow module
- package: root (`src/test-kernel/support/`; suites in `packages/*/test`)
- kind: refactor
- size: M
- earlier: RT6/R6 (landed, #14826) and RT8 (landed, #14823). Remainders:
  R6's last bullet, "two answers to where a host's storage root is"
  (`R-test-infrastructure.md:461-465`), still holds; RT8's renames of
  `FakeHosts.ts` and `ProgressControllerHarnesses.ts`
  (`R-test-infrastructure.md:637-639`) were not made.
- open PR: #14949 edits `ExecutionsToolWorkspaceFiles.vitest.ts` and
  `completedRunArchive.vitest.ts` (both call `createTempDirPlatform`) but not
  the support files; it leaves this whole.

**Evidence.**

- _One name, two types._ `FakeHost` is the record interface
  (`src/test-kernel/support/setupPlatform.ts:44-56`) and the
  `Context.Service` serving it (`testKernel.ts:107-141`). Both importers that
  need both rename one on import: `testKernel.ts:82`
  (`type FakeHost as InstalledHost`) and
  `packages/harness/test/model/ProviderCapabilities.vitest.ts:16`
  (`type FakeHost as HostRecord`).
- _Four files, three nouns._ The host is built across `FakePlatform.ts`
  (`createFakePlatform` returning `FakeProcessPorts`, `createFakeWorkspaceRoots`,
  `makeHostRoot`, options type `FakePlatformOptions`), `setupPlatform.ts`
  (`createFakeHost`, which only calls those three, `:59-84`, plus the
  unrelated `globalValuesOver`), `tempDirPlatform.ts`
  (`createTempDirPlatform`) and `testKernel.ts` (`FakeHost.layer`).
  `createFakePlatform` and `makeHostRoot` have one consumer each, the
  sibling `setupPlatform.ts`. "Setup" in `setupPlatform.ts` collides with the
  setup tools' `SetupPlatformShape` that the same file imports (`:14`); the
  file name is also the tier marker `vitest.config.mjs:77` keys on. The RT8
  names are unchanged: `FakeHosts.ts` holds fake UI ports
  (`createFakeUIHosts`, 2 consumers), `ProgressControllerHarnesses.ts` holds one
  function, `asDocumentTask` (2 consumers).
- _Three storage inputs._ Production derives a root's global storage from
  its storage root (`packages/harness/src/effect/processLayer.ts:251`,
  `resolveGlobalStoragePath(options.storageRoot)`). The fake host takes
  `storagePath` and `globalStoragePath` as independent options
  (`FakePlatform.ts:226-229`) while `storageRoot` is always the worker's
  (`:271`). So a `createTempDirPlatform` host
  (`tempDirPlatform.ts:44-58`, 5 suites) has `globalStorage` under its own
  `<tmp>/storage` and `storageRoot` in the worker's shared directory, a pair
  production never builds; `storageRoot` is what memories, `AGENTS.md` and
  skills read (`PromptBuilder.ts:149`, `runtimeSkills.ts:113`,
  `templateInputs.ts:135`). Two suites restate `createTempDirPlatform`'s
  derivation by hand (`LatexProcessingHelpers.vitest.ts:69-70`,
  `LatexdiffShadowStorage.vitest.ts:56-57`), and `History.vitest.ts:106-107`
  passes one path as both.

**The design decision behind it.** "What is a fake host, and where does it
keep its data?" is spread over four modules, and the storage layout that
production owns (`resolveWorkspaceStoragePath`, `resolveGlobalStoragePath`)
is decided again by each caller of the options.

**The better design.** One module, `fakeHost.ts`: the `HostRecord`
interface, `makeFakeHost(options, overrides)` (today's `createFakeHost`, with
`createFakePlatform`, `createFakeWorkspaceRoots`' defaults and `makeHostRoot`
inlined or file-local) and the fakes it composes; `FakeHost` stays the
service name only. The options take one `storageRoot` and derive
`storage` and `globalStorage` with the production functions, so
`createTempDirPlatform` becomes `makeFakeHost({ storageRoot: tmp })` and the
two hand derivations go. `globalValuesOver` moves to the store-faults or
session support it belongs with. The tier marker in `vitest.config.mjs:77`
follows the rename. Rename `FakeHosts.ts` to `fakeUiPorts.ts` and inline
`asDocumentTask` into a support module of document-task fixtures (or keep the
file under a name that says what it holds). Deleted: `setupPlatform.ts`,
`FakePlatform.ts`'s three single-consumer exports, two import aliases, the
`storagePath`/`globalStoragePath` options (6 suite call sites move to
`storageRoot` or to the default).

**What we give up, and risk.** `createFakeWorkspaceRoots` has 5 direct suite
consumers that build roots without a host; it stays exported. A suite that
deliberately sets a storage path outside any storage root
(`sessionEvents.vitest.ts:230`, `settingsMemoryCommands.vitest.ts:78`) keeps an
override for `storage` alone, which is a narrower option than today's two.

**How I tried to refute it.** Checked whether the worker-shared storage
root is intended for every host: it is the default (`FakePlatform.ts:79-84`,
"which every fake host shares"), but `createTempDirPlatform` exists exactly to
own its storage, and only half of it does. Checked that the alias pair is not
deliberate API: neither alias is exported; both exist only to dodge the
collision. Grepped `.agents/docs/` for `createTempDirPlatform`,
`InstalledHost`, `HostRecord`: only R6's bullet and RT8's names, both above.

## RT-6: The harness's test kernel is built on the CLI's validation bundle layer and TeXRA's setup-tool port, so harness suites depend on two packages above the harness

- flags: special-general mixed, information leakage, overexposure
- package: root (`src/test-kernel/support/`; touches `packages/harness/test`)
- kind: refactor
- size: M
- earlier: none for the kernel's dependency. Round 2 (`K-cli.md`,
  K11) proposed moving the validation scenarios into test support; RT5
  (#14823) made the scenario a value. Neither removed the kernel's default.
- open PR: #14949 edits `BashTool.vitest.ts` and
  `ExecutionsToolOutput.vitest.ts` but keeps their `validationModelLayer`
  import; it leaves this whole.

**Evidence.**

- `src/test-kernel/support/testKernel.ts:65` imports
  `validationModelLayer` from `@cli/runtime/models/validationModel`, and the
  default process every kernel suite builds is
  `composedProcess([], validationModelLayer)` (`:280`). That layer is the
  CLI validation bundle's gate: `enabled` is false unless the `SWITCH`
  environment variable is `1`, and with it set dies without an absolute flag
  path
  (`packages/cli/src/runtime/models/validationModel.ts:395-403,605-608`). In a
  kernel worker the switch is unset, so the default graph carries a model
  that is always off. The harness's own port says absence is the normal case:
  "Absent, none does" (`packages/harness/src/agent/runtime/modelAccess/routeDecision.ts:36-38`),
  read with `Effect.serviceOption` (`routeDecision.ts:94`, `binding.ts:141`).
- `SessionGraph.with(extra, model, platform)` (`testKernel.ts:232-238,301`)
  makes the model a required positional, so a block that only wants a
  scripted spawner must still pass one. Two harness package suites import
  the CLI module for nothing but that slot:
  `packages/harness/test/tools/BashTool.vitest.ts:29,127-130` and
  `ExecutionsToolOutput.vitest.ts:28,166-169`.
  `sessionStore.vitest.ts:38,193` does the same.
- The general fake host carries TeXRA's setup-tool port:
  `FakeHost.setup?: SetupPlatformShape` (`setupPlatform.ts:55`),
  `FakeHostOverrides.setup` (`FakePlatform.ts:252`),
  `TestApp.plugins: (setup: SetupPlatformShape) => …` (`FakePlatform.ts:135`),
  and the kernel's `followedPorts` forwards it with two getters
  (`testKernel.ts:166-175`). `HARNESS_APP.plugins` ignores the argument
  (`FakePlatform.ts:147`); only `TEXRA_APP` reads it (`texraApp.ts:22-23`).
  Five suites set it (`CredentialReporting`, `SendToTerminalTool`,
  `ExecutionsToolOutput`, `DefaultSetupPlatform`, `InvokeCommandTool`).
- 46 of `packages/harness/test`'s 102 suites import `@test/support/testKernel`
  or `texraApp`, so each loads `packages/cli/src/runtime/models/validationModel.ts`
  (608 lines) and its imports.

**The design decision behind it.** "What does a harness process need to run
in a test?" is answered with the CLI's answer (its validation gate) and
TeXRA's (its setup port), the way the root rules forbid in production: "The
harness imports nothing from the app" and "a general core that takes the
app's vocabulary as data".

**The better design.** The kernel's default process provides no
`ValidationModel`; `SessionGraph.with` takes an options object
(`{ plugins?, model?, platform? }`) so each argument is named and optional.
Suites that play a canned scenario keep naming
`validationModel(scenario)` (`goldenStore`, crash conformance through
`validationHost`), as TeXRA suites name `TEXRA_APP`. The setup port moves
into TeXRA's app value: `texraApp({ setup })` returns a `TestApp` whose
`plugins()` closes over it; `TestApp.plugins` takes no argument, and
`FakeHost.setup`, `FakeHostOverrides.setup` and `followedPorts`' setup getters
go. Deleted: the `@cli` import from `testKernel.ts` and from the three suites,
two getters, three `setup` fields.

**What we give up, and risk.** A setup-tool suite that changes the setup
platform per test while sharing one block process would need a per-test
process (`buildPerTest`), since the app value is read when the process
builds; of the five, `CredentialReporting.vitest.ts:44` already builds its
host at file scope. A suite that relied on the env switch to turn the
default model on would fail loudly at bind ("a run recorded on the
validation route fails to bind"), which is the signal to name the model.

**How I tried to refute it.** Checked whether any kernel suite sets the
`SWITCH` environment variable to turn the default on: RT5 removed the
in-process env patching (`RunScopedToolOverlay`'s hooks), and the suites
that play scenarios pass `validationModel(...)` as a value. Checked that
`processLayer` does not require the service: both readers use
`serviceOption`. Grepped `.agents/docs/` for `validationModelLayer`: only
R-test-infrastructure's note that it "stays the bundle's gate", which is what
this keeps.

## RT-7: Batched remainders in the test support: the global `fetch` seam, the wall-clock poll, single-consumer support files and the "parked" vocabulary

- flags: non-obvious code, shallow module, overexposure, vague name, repetition
- package: root (`src/test-kernel/`, `scripts/`)
- kind: refactor
- size: S
- earlier: RT8 (landed, #14823) proposed (a) and (b) and they are its
  remainders; (c) to (e) are new
- open PR: none

**Evidence and the change, per instance.**

- **(a) The global `fetch` seam, RT8's remainder.** `testHttpClientLayer`
  (`src/test-kernel/support/fetchTestUtils.ts:22-28`) serves "whatever
  `globalThis.fetch` is at call time"; RT8 moved six of its seven consumers to
  `noHttpClientLayer`, and the seventh, `UsageLogService.vitest.ts`, still
  patches the global twice (`:40`, `:183`), which `src/test-kernel/AGENTS.md`
  forbids ("Never patch `globalThis`"). Change: the suite provides
  `FetchHttpClient.Fetch` with its scripted function (`Layer.succeed`), and
  `testHttpClientLayer` is deleted (1 consumer).
- **(b) The wall-clock poll, RT8's remainder.** `waitForCondition`
  (`asyncTestUtils.ts:17-41`, a `Date.now()` loop over 10 ms sleeps, split
  into a single-caller `pollForCondition`) keeps 2 consumers inside
  `it.effect` bodies through `Effect.promise`:
  `ToolAvailabilitySeeding.vitest.ts:54-56` polls `spawner.calls.length`,
  which the scripted spawner's `script` callback could signal through a
  `Deferred` it completes; `RunProgressRenderer.vitest.ts:153-158` polls the
  painted output, which `Effect.repeat` with a `Schedule` and
  `Effect.timeout` expresses inside the test's own runtime (and on its
  clock when the renderer's paints are clocked). Change: both sites, then
  delete `asyncTestUtils.ts` (2 consumers).
- **(c) Single-consumer support files and one-step wrappers.**
  `toolAvailabilityTestLayer.ts` (one export, one consumer,
  `testKernel.ts:84,259`); `scripts/aliasUtils.mjs` (`loadAliases`, one
  consumer, `scripts/aliases.mjs:9`, whose own header already explains the
  map); `src/test-kernel/settings/litComponentTestUtils.ts` (202 lines, one
  consumer, `progressView/BashRequestPanel.vitest.ts:9`, in a directory that
  holds no settings suite); `desktopTestPaths.ts:18-20` `moduleFileUrl`, which
  is `pathToFileURL(path).href` (2 consumers); `support/repoScan.ts`, a file
  named "scan" that exports one constant `REPO_ROOT`, built with
  `fileURLToPath(new URL('.', import.meta.url))` where `import.meta.dirname`
  serves. Change: inline each into its one consumer (or rename `repoScan.ts`
  to what it holds), fold `loadAliases` into `aliases.mjs`, and move
  `litComponentTestUtils.ts` beside the suite that uses it.
- **(d) Exports nothing imports.** `CrashScenario` and `CrashShard`
  (`crashConformance.ts:852,856`) and `LogCapture` (`logSinkCapture.ts:22`)
  have no importer outside their file. Change: drop the `export`.
- **(e) "Parked", which the "Plain names" table refuses.** The support
  coins it for a run waiting for input: `parkedAfter` defined twice
  (`crashConformance.ts:422`, `storeFaults.ts:543`), `parkedRoot`
  (`storeFaults.ts:562`, 1 consumer), `parkedRunAfterCrash`
  (`storeFaults.ts:596`, 1 consumer), and comments at
  `storeFaults.ts:18,212,541,559,582,592`. Change: `waitingAfter`,
  `waitingRoot`, `waitingRunAfterCrash`, comments to "waiting". (The
  duplicate definition itself is settled by the 11-04 note's C3, cited at
  `R-test-infrastructure.md:670-674`; only the name changes.)

**The design decision behind it.** None new: each item is an instance the
earlier rounds named or a small support module that never earned its file.

**What we give up, and risk.** Nothing a suite checks; (a) and (b) change
two suites each, the rest are moves and renames.

**How I tried to refute it.** For (b), checked that the renderer suite's wait
is not on a real subprocess (it is not; it waits for a fiber's paint), so the
AGENTS allowance for real sleeps does not cover it. For (c), counted
importers with `grep -rlE "<file>['\"]"` over `src`, `packages/*/test` and
`scripts`. For (e), checked that "parked" is no persisted or wire string in
the support (it is not; the validation gate's file name `golden-park.release`
in `packages/cli/src/runtime/models/validationModel.ts:144` is production and
left to the CL/LC audits).

## RT-8: The TUI frame validator drives its 144 scenarios by wall clock, so the full run takes about 11 minutes, CI runs 12 of them, and the rest have already rotted once

- flags: non-obvious code, comment restates code
- package: root (`packages/cli/scripts/validate-tui.mjs`, `.github/workflows/ci.yml`)
- kind: refactor
- size: M
- earlier: the 11-07 catalogue lists "a nightly job for the full
  `validate:tui` run (CI still runs `--smoke`)" as open with no owner and no
  row (`2026-11-07-design-red-flags-lenses/catalogue.md:117-119`); #14882 had
  to repair 14 of 144 scenarios that failed on `main` unseen
  (`catalogue.md:155-160,258-259`). The wall-clock cause was not named.
- open PR: none

**Evidence.** `packages/cli/scripts/validate-tui.mjs` (3,735 lines) waits by
time, not by state, at every step of a scenario (`:3585-3640`): boot polls
every 150 ms until the frame shows `'◆'` and the PTY has been quiet for
600 ms (`:3587-3601`); after each keystroke it sleeps a fixed
`key.delayMs ?? scenario.keyDelayMs ?? 500` ms (`:3606-3609`, again
`:3616-3619` and for resizes `:3610-3614`) whether or not the UI has
answered; it then settles for up to `scenario.settleMs ?? 4000` ms
(`:3626-3636`). Thirteen keys carry hand-tuned delays (one of 12 000 ms,
`ASYNC_FORM_SETTLE_MS`, `:86-89`; others 200 to 2 500 ms, `:249,1353,1393,1628`),
and 21 scenarios tune `settleMs`. Only the 12 scenarios tagged
`smoke: true` (of 144) run in PR CI (`ci.yml:315-319`); no scheduled job runs
the rest (`ci.yml:8-9` schedules only the test shards and runtime
validation). The header still says "This is intentionally small: a handful
of scenarios" (`:11-14`).

**The design decision behind it.** "When has the TUI answered this key?" is
answered with a guess in milliseconds. A guess long enough for a loaded CI
runner makes the full run too slow to gate on, and a guess too short makes a
scenario flaky, so the suite is split into a gated dozen and an ungated
remainder that fails silently (14 failures on `main` before #14882). The
repo's rule for E2E is the opposite: "Synchronize on published signals,
never wall-clock" and "Never use `waitForTimeout`"
(`src/test-kernel/AGENTS.md:123-136`).

**The better design.** Each key names what it waits for: a key is
`{ input, until }`, where `until` is a frame text (the driver already has
`expectedFrameTextVisible`, `:3631`, for the final frame) or a harness event.
The driver polls the emulated frame until `until` holds, with one timeout per
scenario rather than a sleep per key; keys with no visible effect (typing
into the composer) wait for their echo. The harness can also print a marker
after each Ink commit for the validator to wait on instead of "600 ms of
quiet". With waits ending on state, the full run's time is the UI's, and it
joins CI (the nightly `schedule` at least, or every PR if it is fast enough),
so the `smoke` tag and the split go. Deleted: `ASYNC_FORM_SETTLE_MS`, the
per-key `delayMs` and per-scenario `settleMs`/`keyDelayMs` knobs, the false
header sentence.

**What we give up, and risk.** Writing an `until` for each of the
scenarios' keys is mechanical but long (the scenarios are about 3,000 lines).
A wait on frame text can pass on a stale frame that already showed the text;
an Ink-commit counter from the harness avoids that.

**How I tried to refute it.** Checked whether the delays only pace input
for a terminal that drops fast keystrokes: the default applies after every
key, including those whose answer the scenario then asserts, and the 12 s
delay waits for an async form to load, which is a state. Checked that the
full run has no other home: `ci.yml` has no `validate:tui` without
`--smoke`, and no other workflow names it. Grepped `.agents/docs/` for
`delayMs`, `keyDelayMs`, `validate:tui`: only the catalogue's open nightly
item and #14882's repair.

## RT-9: CI and test-config comments that are false or cite a deleted document

- flags: comment restates code
- package: root
- kind: docs
- size: S
- earlier: none for these lines
- open PR: none

**Evidence.**

- `.github/workflows/ci.yml:253-255` defends Windows staying off PRs with
  "The inventory of genuine Windows defects the matrix did surface is in
  2026-07-29-open-source-readiness.md §4.6". That file is gone: it lived under
  `.agents/docs/archived/process/` and was deleted with that directory
  (`git log --diff-filter=D`), and no copy exists in the tree. A citation in
  place of a reason, now pointing nowhere; `npm run gate:docs` does not read
  workflow comments, so nothing caught it.
- `vitest.config.mjs:19-22`: "Windows CI is opt-in (see the `test` job …),
  so this branch still applies to on-demand runs and to local runs on
  Windows". Windows runs every night (`ci.yml:257-265`, the `schedule` event
  selects `windows-latest`, #12943), which is the main reason the 20 s
  timeout exists.
- `ci.yml:406`: "type checking is the static-checks job's". No job has that
  name; the type check is the `typecheck` job (`:181-200`).

Three more false comments are filed with their design findings above:
`scripts/isolated-home.mjs:1-6` (RT-2), `verify-desktop.mjs`'s package
summary (RT-3) and `validate-tui.mjs:11-14` (RT-8).

**The design decision behind it.** None; these are comments that outlived
the facts they state.

**The better design.** State the reason in place of the citation (the
Windows-only failures the matrix found were path and filesystem
assumptions, which the nightly run now catches within a day, as
`ci.yml:257-262` already says, so the citation sentence can go); say
"Windows runs nightly and on dispatch" in `vitest.config.mjs`; name the
`typecheck` job.

**What we give up, and risk.** Nothing.

**How I tried to refute it.** Searched the working tree for the cited file
(`find . -name '2026-07-29-open-source-readiness.md'`: none) and the history
for its deletion. Read the `test` job's matrix expression for the Windows
schedule.

## RT-10: Scripts reach production TypeScript through two hand-built esbuild bundles, and the desktop fixture's hand-written type already declares three exports the bundle does not have

- flags: repetition, information leakage, non-obvious code
- package: root (touches `packages/cli/scripts/generate-golden-store.mjs`)
- kind: bug
- size: S
- earlier: none
- open PR: none

**Evidence.** Two scripts bundle production modules from an esbuild `stdin`
export list with the same options (`platform: 'node'`, `format: 'esm'`,
`target: 'node22.16'`, the root `tsconfig.json`), write the bundle to a temp
file and `import()` it: `scripts/desktop-package-smoke-environment.mjs:91-130`
(`bundleDatabaseFixture`, 14 exports) and
`packages/cli/scripts/generate-golden-store.mjs:1031-1052` (`loadRowCodec`,
5 exports). The first also hand-copies half of the CommonJS-globals banner
(`:125-127`) that `scripts/esm-cjs-globals-banner.mjs` owns.

The fixture's type is a third, hand-kept list:
`scripts/desktop-package-smoke-environment.d.mts:10-41` (`DatabaseFixture`)
`Pick`s the members by name from 11 `typeof import('…')` types (a form root
`AGENTS.md` "Code style" refuses: "never `import('pkg').T`"). It has drifted
from the bundle: it declares `ProcessIdentity` (`:19`), `processOwnerId` and
`processStartIdentity` (`:32-35`), and the `stdin` list (`:102-111`) exports
none of them. A spec that reads `fixture.processOwnerId` type-checks and gets
`undefined` at run time. Nothing reads them today (0 hits in
`packages/desktop/tests`), which is why nothing failed.

**The design decision behind it.** "Which production modules does a script
or an e2e fixture get, and with what types?" is answered by an export list in
a string and, separately, by a declaration file; no compiler compares the two.

**The better design.** The export list is a real TypeScript module,
`scripts/fixtures/sessionDatabase.ts` (`export { … } from '…'`), checked by
`npm run typecheck`; the bundler takes it as an entry instead of `stdin`, and
the e2e helper's type is `typeof import` of that one module (or the `.d.mts`
re-exports from it with a top-level `export type`), so the list exists once.
One script helper, `bundleSources(entry, outfile)`, carries the esbuild
options and the banner (importing `esmCjsGlobalsBanner`) for both bundlers;
RT-1's service helpers would use the same bundle. Deleted: the 32-line
`DatabaseFixture` type, the copied banner, one of the two option blocks.

**What we give up, and risk.** The fixture module must stay out of the
production bundles (it lives under `scripts/`, which no host bundles).
`playwright.config.ts:32-37` externalises the bundle by its file name
(`session-database-fixture.mjs`); the output name must stay.

**How I tried to refute it.** Checked whether the three extra members reach
the bundle another way (a re-export inside one of the listed modules): the
bundle's surface is exactly its `stdin` re-exports, and none of the listed
modules is `nodeProcesses` or `sessionEvents`. `git log -S` shows #14896 (which
reworked process identity) added the three names to the `.d.mts`, and no
commit ever added them to the `.mjs`.

## Good modules in this area

- **`scripts/release-version.mjs`** with `.github/actions/release-channel`:
  one grammar for release versions, channels and the Marketplace renumbering,
  run by every publishing job before anything publishes; `bump-workspace-version.mjs`
  imports it rather than restating it.
- **`scripts/ratchet-base.mjs`** behind `check-fact-spread.mjs` and
  `check-row-kinds-ever.mjs` (33 lines): checks against the merge base, with a
  loud error when the base is missing and no committed baseline.
- **`oxlint.config.mts`'s zone tables**: each ban set listed once with where
  it holds, alias bans derived from `tsconfig.json`, overrides generated in
  depth order. Every listed path exists, and each runtime entry it exempts
  does run an Effect.
- **`ci.yml`'s `validate-status`**: one `needs` list, `jq` over
  `toJSON(needs)`, and the required set computed from the event.
- **`childProcessTestLayer.scriptedSpawnerLayer`** and
  **`storeFaults.sessionStoreFaults`**: fakes at the real edge built with the
  library's own constructors, released by scope.
- **`vitest.config.mjs`'s tier scan**: membership computed from each suite's
  import closure, with `isolated` as the catch-all for a file the scan has not
  seen.

## Already settled, left alone

- `walkFiles` on the recursive `readdirSync`: refused
  (`.agents/docs/refuted-candidates.json`, `SCRIPT-walkfiles-recursive-readdir`).
- `extension-package-utils.mjs` as a module: refused, its premise false
  (`2026-11-07-design-red-flags-round-4/X-compromises-today.md:188`).
- The review workflows' inline `CLAUDE_ALLOWED_TOOLS` list: S9, held for the
  owner (`catalogue.md:1316`).
- Keeping both `useTempDirs` and `withTempDirEffect`: RT8's own decision
  (`R-test-infrastructure.md:606-609`).
- The duplicate `parkedAfter` definition, `killedHost`, `crashAt`'s table list,
  the crash suite's hand shards, `PROCESS_SERVICES` as a value list and
  `sessionStoreFaults`' `Object.assign`: settled by the 11-04 note and R3-R
  (`R-test-infrastructure.md:668-694`). RT-7 renames only.
- `testKernel.ts`'s `CurrentHost` and `followedPorts` (a block process that
  follows per-test hosts): the design #14826 landed for R6. RT-6 removes only
  the setup getters.
- `check-guidance-refs.mjs` reading the row vocabulary by regex from TS
  source: the `guidance-refs` job installs nothing on purpose
  (`ci.yml:204-208`) and the reader throws when a source or declaration moves
  (`check-guidance-refs.mjs:185-206`); `config/storage/row-kinds-ever.json` is
  no substitute, since it keeps retired kinds. Not reported.
- `PURE_DIRS` in `vitest.config.mjs`: it keeps 9 host-free suites in `kernel`
  by directory, but the excluded directories (`effect/`, `platform/`,
  `desktop/`) hold suites that build the real platform through production
  code, which the scan cannot see; a deliberate guard. Its `logger` entry
  names no directory (dead, one line).
- The `storage:freeze` mode of `rowVersions.vitest.ts`: a releasing step by
  design (`.claude/skills/releasing/SKILL.md:23`).
- Esbuild Node targets differing per bundle (`node20` worker, `node22.16`
  fixtures, `node24.x` hosts): each is the runtime that bundle runs on, or
  lower; harmless.

Candidates dropped on verification: 9 (the guidance-check vocabulary scrape,
`PURE_DIRS`, the per-bundle Node targets, the review workflows' duplicated
quota-comment steps, `isolatedSessions`' module counter, describe titles
citing source paths (3, all valid), the tex-template loaders (a host
concern), `bump-workspace-version.mjs`'s manifest list (it matches the
versioned packages), and the installer extension list in the workflow matrix
(S8's own design)).
