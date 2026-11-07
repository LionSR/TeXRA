# Lens 3: tests that cannot fail, or that test the fake

Commit: `main` at `c9ceb23`. Read-only audit. Three claims were checked by
running a probe suite from the scratchpad (a copy of the suite's own setup
with one input changed), under a config that imports the root
`vitest.config.mjs`; no repository file was touched. Those claims are marked
**executed**. The rest are verified by reading the code; anything unchecked
is marked "unverified".

## Numbers

- Scope: 267 suites. `src/test-kernel` 125 files / 19.3k lines,
  `packages/harness/test` 84 / 7.3k, `packages/llm/test` 11 / 1.7k (plus 12
  `test-live` route files over one 360-line `support.ts`),
  `packages/texra/test` 17 / 0.6k, `packages/cli/test` 4,
  `packages/extension/test` 2, `packages/desktop/test` 3, desktop e2e 11
  specs / 3.6k, `supabase/functions` 10 / 0.9k.
- Assertion shapes this lens looks for:
  - `toHaveBeenCalled*` 59 hits in 25 files; `vi.fn` 152 hits in 41 files;
    `vi.mock`/`vi.doMock` in 22 files.
  - `toBeDefined()` 9, `not.toThrow` 1, snapshots 0, `expect(true)` 0.
  - 11 suites assert `status: 'error'` and contain no successful call. 4
    of them never check the error text (F1, F5).
  - Defaults re-asserted: 1 site uses a schema's decoding default as the
    expected value (F4). `Settings.defaultOf` appears once, as a data check
    (`ModelOptionsBasic.vitest.ts:15`, fine).
- Most `toHaveBeenCalled` hits are real outcomes: a port double's call _is_
  the effect under test (`OverleafClone.vitest.ts:70`,
  `SessionSurfaces.vitest.ts:119`, `DesktopWindowLifecycle.vitest.ts:36-50`).
  This lens reports only those where the call or value comes back from the
  fake itself.

## Findings

### F1. The setup-tool allowlist suites record calls on a host the tool never reaches

**Flags:** a test of the fake (its recorder is never wired in); tautology.
This is a security contract: no credential or arbitrary command reaches the
host.

**Evidence.**

- `src/test-kernel/tools/setup/InvokeCommandTool.vitest.ts:23-41` builds
  the recording host with `yield* Layer.build(FakeHost.layer({}, { setup:
  createFakeSetupPlatform({ commands: { invoke: … invocations.push … } }) }))`
  and throws the returned context away. `invoke` (`:43-46`) provides
  `withSetup(nativeToolTestLayer())`. `withSetup`
  (`src/test-kernel/tools/setup/fixtures.ts:22-25`) reads
  `FakeHost.useSync((fake) => fake.setup ?? {})` from the fiber's context,
  and that is the block's default host (`layer(SessionGraph.hosted)`, `:48`).
  A nested `FakeHost.layer` only re-points the block's `CurrentHost` ref
  (`support/testKernel.ts:124-132`), not the `FakeHost` service that
  `withSetup` reads.
- `src/test-kernel/tools/setup/SendToTerminalTool.vitest.ts:36-50`: the same
  thing with the `terminal` recorder `runs`.
- **Executed.** Same setup, same recorder, an _allowlisted_ command
  (`texra.setApiKey`, no args):
  `{"status":"error","error":"VS Code command invocation is unavailable in this host."}`,
  with 0 invocations recorded. A valid single-line terminal command
  (`echo ok`) gives
  `{"status":"error","error":"VS Code integrated terminal execution is unavailable in this host."}`,
  with 0 runs recorded.
- So every assertion in both files holds whatever the code does:
  `assert.equal(result.status, 'error')` (`InvokeCommandTool:59,75`,
  `SendToTerminalTool:89-93`), `invocations.length === 0` (`:60,77`) and
  `runs.length === 0` (`:95`).
- **What they would catch:** nothing. Delete `assertInSetupAllowlist`
  (`InvokeCommandTool.ts:68`), or the newline filter
  (`SendToTerminalTool.ts:25`), and both suites still pass, because the tool
  then fails on the missing port instead. Churn: 1 and 2 refactor commits
  since 11-01.

**The design decision behind it.** Which host a setup tool reads. The suite
builds one host and reads another, and nothing in the assertions tells the
two apart: each case checks only that the call failed, and the suite has no
case where a call succeeds.

**The better design.** Provide the context that `Layer.build` returns
(`Effect.provide(context)` around `invoke`/`callTool`), or build the host
with `it.layer(FakeHost.layer(...), { buildPerTest: true })` as
`CredentialReporting.vitest.ts:44,63` does. Then make the rejection
specific: assert the message (`Command … is not in the setup allowlist`,
from `assertInSetupAllowlist`; `command must not contain newline`,
`SendToTerminalTool.ts:26`). Add one allowed call to the existing
`InvokeCommandTool` case (an assertion, not a new test) that records exactly
one invocation. Without that control, an assertion of "0 recorded" proves
nothing.

**What we give up.** Nothing. Risk: once wired, the allowlisted control
must not open an approval (`requiresApproval: true`, `InvokeCommandTool.ts:98`).
`.call` bypasses the run loop's guard, so it does not (verified by reading).

**Size.** 2 files, about 10 changed lines.

**Change amplification.** "A new setup tool with an allowlist": copying
either suite gives a test that passes before the allowlist exists.

**Depends on:** none.

### F2. `applyHelperModelPreference`'s only test passes on the "no helper configured" branch, not the "unavailable" branch it names

**Flags:** cannot fail. The setup puts the code under test on its first early
return.

**Evidence.**

- `packages/harness/test/agent/runtime/helperModelPreference.vitest.ts:17-32`:
  "falls back to the selected model when the helper model is unavailable".
  It runs over `SessionGraph.hosted`, whose default host is `HARNESS_APP`.
  Its catalog has no rows and no defaults
  (`src/test-kernel/support/FakePlatform.ts:140-143`). The harness's
  `HELPER_MODEL_SETTING` has no default by design
  (`packages/harness/src/shared/state/stateSettings.ts:518-530`).
- So `getHelperModelName` returns `undefined`, and
  `applyHelperModelPreference` takes its first return:
  `if (helperModel === undefined || helperModel === config.model) return config;`
  (`packages/harness/src/agent/runtime/helperModelName.ts:62`). The
  unavailable branch (`:75-…`, `readModelOptions` → `unavailableReason`)
  never runs.
- **Executed.** `getHelperModelName` over the default harness host gives
  `undefined`. Over `FakeHost.layer({ app: TEXRA_APP })` it gives
  `deepseek/deepseek-flash@none`.
- **What it would catch:** nothing about availability. Delete the
  `unavailableReason` check: the launch then swaps to a helper model with no
  key, and the run fails at its first call. The suite still passes. It is
  the function's only test, and `rootLaunch.ts:138` is its only caller.

**The better design.** Run the case over `FakeHost.layer({ app: TEXRA_APP })`
under `withEnv({})` with no DeepSeek key, so the helper resolves and is
unavailable. Assert `result.model === selected` and the warning
(`captureLogEntries`, as `tools/core/definition.vitest.ts:33` does).

**What we give up.** The suite reaches the app's catalog, so it is no
longer harness-only. That is the honest dependency: the behaviour exists
only when an app names a default.

**Size.** 1 file, about 4 lines. **Depends on:** none.

### F3. `executeCliConfig`'s approval and shutdown cases assert what their mocks decide

**Flags:** a mock that restates the decision under test; a mock echo.
Churn rank: `ExecuteCli.vitest.ts` 10.

**Evidence.**

- `src/test-kernel/cli/ExecuteCli.vitest.ts:129-135` replaces
  `createHeadlessCliHostInteractions`. At `:268-274` the replacement is
  `approvalPromptsUnavailable: context.mode !== 'interactive'`, a copy of
  production's branch:
  `invocation.context.mode === 'interactive' ? { approve … } : { approvalPromptsUnavailable: true }`
  (`packages/cli/src/runtime/headless/approvalAdapter.ts:191-199`).
- The case "marks headless $policy runs as approval-unavailable"
  (`:333-349`) then asserts `seen() === true`, read back through
  `liveToolGates`. That is the mock's own answer. Change the adapter's
  branch, say to `mode === 'headless'`, or give a headless host an `approve`
  member: the suite still passes, because the adapter does not run. The
  `.each` over `never`/`ask` adds nothing either. Neither case passes
  `autoApprove`, and the mock ignores the policy, so both rows take the same
  path.
- "marks owned runs interrupted during platform shutdown" (`:351-405`) ends
  with `expect(yield* Fiber.join(run)).toMatchObject({ … outcome: 'cancelled' … })`
  (`:400-403`). But `'cancelled'` is `STOPPED` (`:161`), handed in by the
  test at `hangingRun.resolve(STOPPED)` (`:385`), so that assertion is an
  echo. The assertions that do test the command are the `run.stop` request
  with `reason: 'shutdown'` (`:379-383`) and the shutdown waiting on the
  recovery write (`:387-399`).

**The better design.** Drop the `createHeadlessCliHostInteractions` mock
(the `importOriginal` spread is already there) and let the real adapter run
over the test session. Collapse the `.each` to one case. Delete the final
`toMatchObject`, or make the stub's end follow the stop it received (as
`chatSessionController.vitest.ts:353-366` does) so the outcome is the
command's doing.

**What we give up.** Nothing a suite reads. Risk: the real adapter's
`approve` path needs `CliInvocation`. `provideCliInvocation(context)`
already wraps the command (`:202`).

**Size.** 1 file, about −15 lines. **Depends on:** none. Lens 1 may rank the
same file for its five `vi.mock`s; sequence with that.

### F4. "Stops automatic attempts at the configured limit" configures the default, and its expected value is that default

**Flags:** the expected value is computed by production's own schema; it
cannot tell "reads the setting" from "ignores it". Churn rank:
`RetryState.vitest.ts` 13.

**Evidence.**

- `src/test-kernel/agent/runtime/RetryState.vitest.ts:523-531` builds the
  host with
  `caseHost(Schema.decodeUnknownSync(MODEL_RETRY_MAX_ATTEMPTS_SETTING.schema)(undefined))`,
  which is 2, the decoding default (`stateSettings.ts:227-229`).
- `:547-551` expects
  `1 + Schema.decodeUnknownSync(MODEL_RETRY_MAX_ATTEMPTS_SETTING.schema)(undefined)`
  attempts.
- A retry loop that never read `model.retry.maxAttempts` and hard-coded 2
  passes. So does one that read the setting from the wrong slot: the slot
  falls back to the same default.

**The better design.** Seed a literal that is not the default
(`caseHost(3)`) and expect the literal `4`. "Write the expected output
down as a literal" (`src/test-kernel/AGENTS.md`, "Do not duplicate logic
into tests"). `caseHost(0)` at `:392` already shows the pattern.

**What we give up.** Nothing. **Size.** 1 file, 2 lines. **Depends on:** none.

### F5. Rejection cases that accept any error

**Flags:** an assertion too weak to fail. It borders F1, which is the
extreme case of the same flaw.

**Evidence.**

- `src/test-kernel/tools/setup/ConfigTools.vitest.ts:24-41`: "rejects a
  non-allowlisted key without writing" asserts `result.status === 'error'`
  and an untouched config. A layer gap, a schema error or a thrown `die`
  also meets both. The suite has no allowed write. Its second case (`:53-90`)
  is rejected by the approval, not by the allowlist.
- `src/test-kernel/tools/ToolEditApprovalGate.vitest.ts:201-219`: "denies an
  edit under never, and tells the host" asserts `status === 'error'` and no
  opened edit. The denial text the host is told is never checked. The
  sibling case at `:194-195` shows the right form:
  `assert.match(result.error ?? '', /require a prior read/)`.
- These two plus F1's four are the six sites among the 11 suites in the
  Numbers that assert a rejection without its reason. The other suites pair
  `status: 'error'` with a message (`GlobTool.vitest.ts:101-104`,
  `ExecutionsToolWorkspaceFiles.vitest.ts:67-68`,
  `WebFetchTool.vitest.ts:59-60`, `OpenPdfTool.vitest.ts:77-80`).

**The better design.** Assert the rejection's message, which production
already writes: `ConfigTools.ts:117`'s `ToolError`, and the `never`-policy
denial text. Zero new tests.

**Size.** 2 files, 2 lines. **Depends on:** none.

### F6. `ProviderCapabilities`' helper owns the fallback the case is named for

**Flags:** a helper that restates a production rule (R3-R's species,
`../2026-11-07-design-red-flags-round-3/R-test-infrastructure.md` R2/R3),
here one `??`.

**Evidence.**

- `packages/harness/test/model/ProviderCapabilities.vitest.ts:21-35`:
  `contextWindow: facts.chatgptContextWindow ?? config.codexSubscription?.contextWindow ?? Number.NaN`.
  Production's rule is `contextWindow: facts.chatgptContextWindow ?? codex.contextWindow`
  (`packages/llm/src/models/modelRoute.ts:238`). The test re-implements it
  instead of calling `decideModelRoute`.
- The case "falls back when the configured context window is out of
  range" (`:58-77`) passes if `decideModelRoute` loses its `??`, because
  the fallback it checks is the test's own. What it still protects: an
  out-of-range `contextWindowK: 900` reads as `undefined`
  (`modelSettings.ts:223-226`).

**The better design.** Build the route with
`decideModelRoute(gpt55Config, { ...facts, plans: ['chatgpt-subscription'] })`
and pass it to `routeConfig`, as `computeModelOptions.ts:208-214` does.
Expect the literal `400_000`.

**Size.** 1 file, about −6 lines. **Depends on:** open PR #14829 (E's
R3-E2), which edits this file at `:23`. Land after it, owner E.

### F7. "Rapid settings-tab switching does not crash the renderer" is a renders-without-crashing smoke that another spec covers

**Flags:** "renders without crashing" (`src/test-kernel/AGENTS.md` lists it
for deletion); duplicate coverage (lens 6 borders this).

**Evidence.**

- `packages/desktop/tests/e2e/trajectories.spec.ts:243-258` switches five
  tabs, each through a test-posted `setTab` message (`electronApp.ts:288-318`,
  not a user-visible control). It then asserts two chrome elements are
  visible.
- `packages/desktop/tests/e2e/screenshots.spec.ts:116-180` clicks every
  settings tab by role, in both themes. It asserts each is `aria-selected`,
  saves a screenshot artifact, and drives the keyboard navigation.
- **What it would catch:** a renderer crash on a tab switch, which
  `screenshots.spec.ts` catches first through the real control.

**The better design.** Delete it, and its doc comment at `:233-241` (the
"Trajectory 5" comment above it has no test). The suite's header
(`:13-22`) says gaps are documented "with a soft assertion rather than
failing". No `expect.soft` exists in the e2e tree, so that sentence is
false and goes too.

**Size.** 1 file, about −30 lines. **Depends on:** none.

### F8. Batched thin cases: mocks that decide nothing, and lines that assert the test's own value

Each is a line or two, recorded so the fixes can ride with a nearby PR.

- **Mocks no case reaches** (the `vi.mock` puts the suite in the
  `isolated` tier for nothing). This borders the 11-04 note's C7
  (`.agents/docs/proposed/simplification/2026-11-04-store-and-test-support-debts.md`),
  the same flaw in `sessionEvents`.
  - `src/test-kernel/cli/ModelAccess.vitest.ts:14-24` mocks
    `readModelOptions` and `modelOptionsFrom`; its comment says "a case
    seeds the option rows on the read". No case seeds them (`:86` only
    resets). Every case passes `accessList` naming the model, so
    `loadCliModelAccessEntry` returns at `modelAccess.ts:304-305` before
    either is called.
  - `src/test-kernel/agent/output/CompileCheck.vitest.ts:29-37` mocks
    `compileLatex2Pdf`, and `:39-40` says the read fails "before
    compileLatex2Pdf is ever invoked".
  - Fix: delete the mocks. Both suites should leave the `isolated` tier
    (unverified until the tier scan runs).
- **The test's own value asserted.**
  - `src/test-kernel/desktop/DesktopSettingsIpc.vitest.ts:91-98,122-128`:
    `expect(settings.handleMessage(…)).toBe(true)`, where `true` is the test
    wrapper's own `Schema.decodeUnknownResult` of the literal message, not
    anything the IPC returned. Delete the line. `config.get(...)` at `:131`
    is the outcome.
  - `packages/texra/test/controllers/LatexToolingController.vitest.ts:8`:
    `isAllowedLatexInstallCommand(HOMEBREW_INSTALL_COMMAND)` checks that a
    constant is in the set built from it (`LatexToolingController.ts:30-31`).
    The `rm -rf` line (`:9`) is the contract. Keep it and drop `:8`.
  - `supabase/functions/auth-bridge/index_test.ts:26-27`: regex matches on
    the served script's source text (`callbackParams\.delete('app_nonce')`).
    These pin spelling, not behaviour; the nonce embedding at `:25` and the
    400s are the contract. Keep them, or run the script.
  - `src/test-kernel/cli/chatSessionController.vitest.ts:381`:
    `expect(session.runSettled).toBeDefined()` right after a claim the
    fixture made. The `vi.waitFor` on `runId` at `:382-384` is the check.
- **A title the assertion does not reach.**
  `packages/llm/test-live/support.ts:333-349`, "chains the next turn on the
  anchor the first left", sends the full history _and_ the anchor
  (`:152-165`). Then it asserts only `finishReason === 'stop'` and non-empty
  text, which also holds for a codec that ignores the anchor. Either rename
  it to what it shows (a turn carrying an anchor is accepted) or assert the
  prefix the codec omitted. That needs a request hook; unverified that one
  exists.

## Good suites worth copying

- `src/test-kernel/progressView/SessionSurfaces.vitest.ts`: a call count
  that is the outcome (two Sends, one request), with the draft state checked
  after each answer.
- `src/test-kernel/latex/OverleafClone.vitest.ts`: port doubles whose calls
  are the effect. Each "clears the token" case has its control ("keeps the
  token" on a network failure and on a pre-git `mkdir` failure).
- `src/test-kernel/latex/TexTools.vitest.ts:104-116`: a regression (exit 0,
  no PDF), with real files and only the subprocess faked.
- `packages/harness/test/tools/core/definition.vitest.ts`: names its
  failure mode, then asserts both the model-visible error and the log line.
- `src/test-kernel/tools/setup/CredentialReporting.vitest.ts`: the host
  built with `it.layer(…, { buildPerTest: true })`, the wiring F1 lacks, and
  asserts the negative (`doesNotMatch(private-test-value)`) beside the
  positives.
- `src/test-kernel/schemas/protocolStability.vitest.ts` and
  `packages/texra/test/model/SetupModelDefaults.vitest.ts`: literal pins and
  data checks with a per-entry message.
- `supabase/functions/log-usage/equivalentCost_test.ts`: every expected
  value written as a literal, with the arithmetic in a comment.

## Already settled, left alone

- Fakes that re-implement `ModelInvoker`, the hand-built TUI `SessionView`,
  and the validation-model env switch:
  `../2026-11-07-design-red-flags-round-3/R-test-infrastructure.md` R1, R3
  and R5 (landed in #14823 and #14826).
- `sessionEvents.vitest.ts`'s spread-only mocks and its internal pins:
  `.agents/docs/proposed/simplification/2026-11-04-store-and-test-support-debts.md`
  C6 and C7.
- The `getChatgptStatus` spy in
  `src/test-kernel/tools/setup/DefaultSetupPlatform.vitest.ts`: the
  call-through lambdas exist so the spy reaches the call
  (`.agents/docs/refuted-candidates.json`, the subscription sign-in
  `sessionName` entry). Not a mock echo: the assertion is that no account
  id reaches the tool output.
- `TuiApprovalRetry.vitest.ts:342`'s
  `Fiber.join(pending) toEqual(PERSONAL_KEY_RETRY)` looks like an echo but
  checks that the request resolves with the surface's decision (the modal
  could rewrite it). The secret-read count at `:348` is the own-key check
  the case is named for. Both kept.
- `chatSessionController.vitest.ts:347-366`: its stub ends a resumed run
  `cancelled` only when a `run.stop` for that id arrived, a session's
  contract. The asserted exit code (`Interrupted`) is the controller's
  mapping, so it is not an echo.
- E2E specs that post host messages themselves (`desktop:showDiff`,
  `desktop:showPdf`, `desktop:setLog` in `trajectories.spec.ts`): renderer
  contracts with exact outcomes. Whether they duplicate kernel suites is
  lens 6's question.
- The crash conformance entries with no `expect` (seven 7-line files):
  shards of `crashConformance.ts`, a deliberate CI split (11-04 note,
  "Checked and rejected").
