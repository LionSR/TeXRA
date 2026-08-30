# CLI ↔ extension/desktop controller seam audit

- **Date**: 2026-08-25
- **Status**: proposed
- **Audited at**: `7213a7d551` (committed HEAD; the working tree held an
  unrelated concurrent refactor, excluded from every claim below)
- **Scope**: `src/controllers/`, `src/auth/`, `src/controllers/session/`,
  `packages/cli/src/runtime/`, `packages/cli/src/chat/tui/state/`,
  `packages/desktop/src/main/`, `packages/extension/src/progressView/`,
  `packages/extension/src/settingsView/`

## 0. What this audit found, and what it did not

Six scoped sweeps ran over the CLI-versus-GUI-host seam: session/progress
projection, approval, execution launch, settings/model-access,
auth/update/onboarding, and a mechanical dead-surface pass.

The headline is that **the seam is in better shape than its own register
says**. The naive framing of this area — "three hosts each assemble the same
run, so extract a shared assembler" — is false at HEAD and was refuted on
evidence, not opinion:

- Extension and desktop already share `prepareMainViewExecutionLaunch`
  (`packages/extension/src/webview/managers/executionHandlers.ts:55`,
  `packages/desktop/src/main/desktopAgentExecution.ts:1227`), and the CLI
  already shares the `validateExecutionRequest` SSOT
  (`packages/cli/src/runtime/runExecution.ts:136`).
- Approval **policy** is single-owner: every host funnels through
  `decideTexraApproval` at the tool boundary
  (`src/tools/approval/bashApproval.ts:100-116`,
  `src/tools/approval/toolEditApproval.ts:216-229`), pinned by
  `src/test-kernel/architecture/approvalPolicyAuthorityRatchet.vitest.ts`.
- Auth session storage, token refresh, and PKCE exchange are single-owner via
  `createHostAuthCoordinator` (`src/auth/SupabaseAuthCoordinator.ts:28`).
- The update-check state machine was already extracted (#9516, 2026-08-01);
  residual shared logic between the CLI and desktop checkers is ~0 lines.
- `SessionRendererPort` has three production implementors
  (`LitSessionRenderer.ts:55`, `sessionSignalsAdapter.ts:54`,
  `runProgressRenderer.ts:394`). It is the shared reducer, not speculative
  generality.

So this document is mostly a **reconciliation plus a leftovers list**, not a
consolidation program. The one structural theme that survived is stated in §2:
where a promotion to the shared substrate has _landed_, the host-side mirror it
was supposed to replace often still stands.

## 1. Register drift: the §4 promotion list is stale

`2026-08-15-single-substrate-hosts-as-renderers.md` §4 lists the facts one host
computes that belong in the substrate. Its last in-doc reconciliation is
origin/main `e00b9317f7` (2026-08-19) and marks five rows OPEN. Re-verified at
`7213a7d551` (2026-08-25), **two of the five have landed**:

| row                               | doc says                                 | actual at HEAD                            |
| --------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `contextState`                    | OPEN, "the hard one", live CLI gauge bug | **LANDED**                                |
| `runStartedAt`                    | OPEN, still CLI-only                     | **LANDED**                                |
| `thinkingActive`                  | OPEN                                     | open — but see §1.1, recommend withdrawal |
| root-run stream identity          | OPEN, three CLI copies                   | open, still three copies                  |
| run input files + `plannedRounds` | OPEN                                     | open                                      |

`contextState` is now on `StreamExecutionState`
(`src/shared/schemas/streamState.ts:165`), owned by `SessionState.ts:87`,
written and invalidated by `SessionFactApplier.ts:180,189`, read by the GUI
hosts at `LitSessionRenderer.ts:180` / `UsagePanel.ts:161` and by the CLI off
the shared record at `statusBarDisplay.ts:239,259` — whose comment now names
`StreamExecutionState.contextState` as the source. No
`MODEL_CONFIGS[model]?.contextWindow` re-derivation remains in that file. The
"CLI gauge wrong on subscription/compaction routes" defect the row was filed
for is fixed.

`runStartedAt` is now on `StreamPhaseState`, produced by
`src/agent/runtime/StreamStatusService.ts:30-40` — which documents itself as
"**The one owner** of 'when did this run start'" — applied at
`SessionFactApplier.ts:357,835,902,932`, and consumed by the GUI hosts at
`LitSessionRenderer.ts:465`. The row predicted "webview gains a live
elapsed-time source"; it has one.

**Action:** update §4's status block. Leaving two landed rows marked OPEN
invites a future sweep to re-do finished work.

### 1.1 `thinkingActive` should be withdrawn, not implemented

The doc already withdrew this row's sibling `compactingActive` on review,
because the webview has compaction liveness via the shared
`CompactionActivityBlock` and "promoting it would mint a second owner beside
the transcript-owned lifecycle."

`thinkingActive` sits in the _same derivation block_ on the _same_
transcript-owned fact:

```
subscribeStreamLog.ts:395-398   compactingActive = compaction.blocks.some(running)   <- WITHDRAWN
subscribeStreamLog.ts:399-402   thinkingActive  = live.messageType === THINKING
                                                   && logEntryStreamIsRunning(live)
```

Both read `projections` / `state.liveActivityEntry`, i.e. the transcript fold.
Promoting it deletes 4 CLI lines and adds a schema field, an applier writer, a
`SessionRenderSlice` member, an `invalidate` call, and a webview consumer —
net-positive LoC and +1 wire-surface element, for a fact the transcript already
owns. The stated benefit ("webview gains thinking liveness") is a feature
decision, not a cleanup.

**Recommendation:** withdraw on the same ground as `compactingActive`.

### 1.2 Rows C11 and C12 of the audit register are still open

Re-verified at HEAD (line numbers moved, structure unchanged):

- **C12** — `MainViewExecutionLaunchResult`
  (`src/controllers/mainView/backend/MainViewExecutionLaunchController.ts:34-41`)
  nests a second union, `MainViewExecutionPreparationResult`
  (`MainViewExecutionController.ts:17-19`), inside its `prepared` arm, so both
  callers unwrap twice (`desktopAgentExecution.ts:1240-1243`,
  `executionHandlers.ts:80-102`). Flattening folds the second `if (!valid)`
  into the existing `status === 'error'` branch. ≈ −14 LoC, −1 exported type.
  Note the full C12 extraction is **not** proposed: it bundles a feature
  decision, because `docsCommand` (`MainViewExecutionController.ts:80`) is read
  only by the extension and silently dropped by desktop.
- **C11** — the proposed `withUnhandledFailureReporting` extraction never
  happened, but the _behavior_ landed on both hosts by copy, so
  `desktopAgentResume.ts:50-116` and `resumeFromResumeData.ts:19-70` now run an
  identical six-step skeleton. This is now two copies where the doc described
  one gap. It carries a decision: desktop has a
  `hasAuthoritativeStream` precheck the extension lacks, so unifying either
  grants the extension new behavior or drops a desktop guard. Flag explicitly;
  do not fold silently.

## 2. The structural theme: landed promotions left their mirrors behind

`StreamSlice`'s lifecycle triple is the clearest case. `cliState.ts:191-197`
carries `status`, `substate`, and `runStartedAt`, written only by
`setStreamStatusInCliState` (`cliState.ts:346-375`) from the same `status` fact
(`sessionSignalsAdapter.ts:230-235`). The file's own comment concedes the field
is "mirrored verbatim from the `status` fact — the session status machine
stamps and clears it (`StreamPhaseState.runStartedAt`)". Readers use it exactly
as `LitSessionRenderer` uses `status?.runStartedAt`.

The supporting machinery exists only to keep the mirror honest:
`PatchableStreamSlice` / `StreamSlicePatch` (`cliState.ts:274-290`), the
dual-argument `patchStream` (`:292-319`), `streamSliceWithStatus` (`:321-335`).
The CLI already has the read-through pattern that would replace it —
`childExecutions.ts:63-86` does exactly this for `contextState`, `stage`,
`conversationProgress`, description, and the parent edge.

≈ −78 net production LoC; −2 types, −2 functions, −3 slice fields.

**Risk: high**, and it should be split rather than attempted whole. Three real
hazards: `StreamStatusMachine.stateFor` is private
(`StreamStatusService.ts:322`), so a single-stream read either widens the frozen
`@agent/*` surface by one accessor or costs a `getAllStreamStates()` allocation
per render; the CLI's write is deliberately ordered _before_ the applier with a
documented reason (`sessionSignalsAdapter.ts:222-229`); and
`setStreamStatusInCliState:359-361` enforces a removed/retired liveness refusal
the status machine does not have, which must move to the reader. Take
`runStartedAt` alone first (5 read sites); do `status`/`substate` only if that
lands clean.

## 3. Bounded leftovers

Filed as `tech-debt` issues rather than carried here (all five now have PRs;
see the status column):

- #11386 — un-export 12 controller types with zero cross-file references
- #11387 — delete the never-produced `activeStream` option on the metadata push
- #11388 — `StreamArtifactProjection` sits in the shared layer with only CLI
  consumers. **Superseded — see §3.3.** The fix landed as #11400 (remove the
  store's defensive clones) rather than #11396 (move the module), which is
  closed.
- #11389 — delete `SupabaseClient.getSessionTokens` (0 consumers, raw refresh token)
- #11390 — CLI re-derives the tool dashboard. **Closed — see §3.3**; the
  `'cli'` arm is load-bearing and the fold was rejected on cost.
  **Partially rejected on cost** (#11397 takes the verified half): the stated
  blocking precondition does not exist — `runProbes` maps over every
  `EXTERNAL_TOOL_DEFS` entry, so no def is ever dropped — and the fold would
  change external-tool host exclusion for extension _and_ desktop, need
  feature-decision fields on `ToolDashboardItem`, and add four host-conditional
  branches, to delete ~40 lines of per-def mapping. Left open for a ruling on
  the unused `'cli'` arm itself.
- #11399 — delete the `activeStream` wire field (follow-up to #11387; the
  surviving frontend branch is an unguarded selection back-channel that
  bypasses `assertKnownActiveStreamId`)

Listed below for the record with their evidence anchors. The remaining rows
(snapshot-port re-projections, `fetchWithTimeout`, the Codespaces doc comments)
are not yet filed.

| item                                                  | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                               | delta                                         | risk               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------ |
| `activeStream` option never produced                  | `SessionRendererPort.ts:60` declares it; sole producer `SessionFactApplier.ts:259-267` constructs `{ streamStates }` only. Dead through `LitSessionRenderer.ts:110,394,400,409`, wire `outbound.ts:70`, and a frontend branch `streamLifecycleSlice.ts:154-158` that never fires. Introduced 2026-08-13 (#10117).                                                                                                                                                      | −15 LoC backend-only, −25 with the wire field | low / medium       |
| Three mainView types knip cannot see                  | `MainViewDroppedFileAttachmentPlan:20`, `MainViewDroppedFileAttachmentInput:28`, `MainViewExecutionLaunchResult:34` — each has only its declaration plus one self-reference repo-wide. Plus `desktopAgentExecution.ts:1198` `runExecution` public with 3 internal and 0 external callers. (`MainViewStartupControllerDeps` was listed here and is **excluded**: it has a test consumer, which is §3.1's "a test is a consumer" case, and #11392 correctly omitted it.) | 0 LoC, −4 elements                            | near-zero          |
| `StreamArtifactProjection` is in the wrong layer      | `src/controllers/session/StreamArtifactProjection.ts:13-17` claims "The CLI **and the shared progress-view controllers** project the same fields". False: every consumer is CLI; `LitSessionRenderer` reads the store directly and never imports it.                                                                                                                                                                                                                   | −10 LoC + a 58-line file move                 | low                |
| `SupabaseClient.getSessionTokens` dead                | `src/auth/SupabaseClient.ts:253` — 0 production consumers (3 test-only). Removing it retires a process-wide accessor for the raw refresh token.                                                                                                                                                                                                                                                                                                                        | −22 prod LoC                                  | low                |
| CLI re-derives the tool dashboard                     | `buildToolDashboardItems` (`ToolDashboardData.ts:162`) is called only with `'desktop'` and `'extension'`; the `'cli'` arm of `ToolHost` (`ToolTypes.ts:8`) is reached only by the CLI's parallel implementation at `packages/cli/src/runtime/tools.ts:33-88`.                                                                                                                                                                                                          | ≈ −40 LoC                                     | medium — see below |
| Stale Codespaces callback doc comments                | `src/auth/config.ts:178` and `UriHandler.ts:18` both claim Codespaces returns `/extension-auth-callback`. The resolver (`extension.ts:455-459`) builds from `getAuthCallbackUri`, which hardcodes `/auth-callback` (`config.ts:140-142`); `asExternalUri` only appends `?state=`.                                                                                                                                                                                      | −14 LoC                                       | low (comments)     |
| `fetchWithTimeout` reimplements `AbortSignal.timeout` | `src/auth/fetchWithTimeout.ts` (24 LoC + a `p-timeout` import) has one consumer; the repo's other 18 timed fetches use `AbortSignal.timeout` directly.                                                                                                                                                                                                                                                                                                                 | −30 LoC                                       | low                |
| Ten inline snapshot-port re-projections               | `desktopAgentExecution.ts:443,495,651,735,845` and `ProgressViewMessageHandler.ts:217,410,514,660,702`, plus a byte-identical `workspace: { locatePath, exists }` pair.                                                                                                                                                                                                                                                                                                | −36 LoC, 0 new exports                        | low                |

Two carry caveats that must not be lost:

- **Tool dashboard.** The shared builder iterates probe _results_ and drops
  defs with no result; the CLI iterates _defs_ and synthesizes
  `status: 'unknown'`. Close that gap first, or `texra tools list` silently
  loses rows.
- **Codespaces callback path.** Fixing the two stale comments and dropping the
  zero-consumer `getAuthCallbackBasePath` export is certain. _Collapsing_
  `AUTH_CALLBACK_PATHS` to one entry depends on VS Code web routing never
  delivering that path to `handleUri`, which grep cannot prove — it needs a
  Codespaces sign-in smoke test. Do not ship the two halves together.

## 3.1 Dead `export` keywords in the shared controllers

A mechanical pass over all 193 exports in `src/controllers/**` and
`src/hosts/uiHosts.ts` (production corpus = `src/` minus `src/test-kernel/`,
`packages/*/src`, `packages/extension/resources/`, `prompts/`,
`supabase/functions/`, plus `packages/extension/package.json` contributions and
`scripts/`) found 44 with no production consumer. Of those, 14 are already in
`config/ratchets/knip-baseline.json`.

The cleanest sub-batch is **12 symbols referenced only inside their own
defining file** — the `export` keyword carries no cross-file traffic at all,
not even to a test. Each was re-verified individually:

| path:line                                                  | symbol                                  |
| ---------------------------------------------------------- | --------------------------------------- |
| `mainView/MainViewDroppedFilesController.ts:20`            | `MainViewDroppedFileAttachmentPlan`     |
| `mainView/MainViewDroppedFilesController.ts:28`            | `MainViewDroppedFileAttachmentInput`    |
| `mainView/backend/MainViewExecutionLaunchController.ts:34` | `MainViewExecutionLaunchResult`         |
| `progressView/ProgressApiKeyRetryController.ts:20`         | `ProgressApiKeyRetryRequest`            |
| `progressView/ProgressApiKeyRetryController.ts:40`         | `ProgressApiKeyRetryResult`             |
| `progressView/ProgressFollowUpController.ts:32`            | `ProgressFollowUpControllerDeps`        |
| `progressView/ProgressFollowUpController.ts:59`            | `CompileFixerInput`                     |
| `progressView/ProgressFollowUpPolishController.ts:16`      | `ProgressFollowUpPolishInput`           |
| `progressView/ProgressFollowUpPolishController.ts:35`      | `ProgressFollowUpPolishControllerDeps`  |
| `progressView/ProgressWorkflowActionsController.ts:39`     | `ProgressWorkflowActionsControllerDeps` |
| `progressView/backend/ExternalInquiryRequestHandler.ts:18` | `ExternalInquiryRequestHandlerOptions`  |
| `progressView/progressStreamControls.ts:21`                | `ProgressStreamControls`                |

### A fourth, unrecorded gate gap

`2026-08-19-dead-code-gate-blind-spots.md` records three gaps. The twelve
symbols above are a **fourth** it does not name, and the demonstration sits
inside one file:

- `MainViewAllowedDropExtensions` (`MainViewDroppedFilesController.ts:16`) is
  referenced only from an interface member, and it **is** baselined as
  `production-dead / types`.
- `MainViewDroppedFileAttachmentPlan` and `...Input` (`:20`, `:28`) are
  referenced directly in the exported `planMainViewDroppedFileAttachments`
  signature, and they appear in the baseline **not at all**.

`knip.json` sets no `ignoreExportsUsedInFile`, so the documented default would
have reported them. The distinguishing factor is reachability from an exported
signature: one level of nesting makes a type invisible to the gate. This
belongs in the blind-spots register beside §1-§3; it is recorded here because
this audit is where it surfaced.

(Credit: caught in review on #11392, which correctly rejected that PR's
original attribution of this mechanism to §1.)

A further 16 exports have test-kernel-only consumers and are **not** baselined —
that one _is_ the species documented in `2026-08-19-dead-code-gate-blind-spots.md`
§1 ("a test is a consumer"). Those need the per-symbol judgement that document prescribes, not
a blanket un-export, so they are not proposed here.

**Correction (both claims below were backwards in the original draft).** An
earlier version of this section called two re-export lines redundant. They were
not, and acting on it would have broken the build:

- `onboardingFunnel.ts:20` (`OnboardingFunnelState`) — `desktopOnboardingIpc.ts:3`
  and `MainViewProvider.ts:23` both import it **from the controller path**. Only
  `mainViewState.ts` goes to `@shared/schemas`. Left in place by #11392.
- `ChatExportController.ts:28` (`ChatExportInput`) — consumed cross-file by the
  sibling `exportTranscript.ts`. Only the CLI's `history.ts` used
  `@agent/export`. #11392 removed the re-export **and repointed that consumer**
  to `@agent/export/schemas`, the declaring module; the deletion was safe only
  because the consumer moved with it.

## 3.2 Ratchets and boundaries are clean

Checked directly rather than assumed, because one survey pass reported
otherwise:

- `hostAgentDeepImportRatchet.vitest.ts` **passes** (9/9) at committed HEAD.
  The live `@agent/*` deep-import set for `packages/cli/src` is exactly the 8
  specifiers already in `host-agent-import-baseline.json`: no stale headroom to
  prune, no new edge.

  One survey pass reported this ratchet _failing_ on a new CLI specifier
  `@agent/modelHandlers/support/reasoningEffort` at
  `packages/cli/src/runtime/modelAccess.ts:2`. That is not a defect in
  committed main — `git show HEAD:packages/cli/src/runtime/modelAccess.ts` has
  no such import — but it is probably not an error either. A concurrent editing
  session was mid-refactor in exactly that code during this audit (uncommitted
  changes to `modelAccess.ts`, `ModelHandler.ts`,
  `modelHandlers/support/reasoningEffort.ts`, `ModelFactory.ts`, plus a new
  untracked `src/model/reasoningLevel.ts`), and the finished shape imports
  `resolveReasoningLevel` from the new shared `@model/reasoningLevel` rather
  than from `@agent/*`. The reported failure is best read as a **real transient
  caught mid-extraction**, which is also a live reminder of the B3 obligation:
  a host reaching into `@agent/*` fails the gate until the extraction lands.

- `subsystemEdgeRatchet.vitest.ts` passes; 0 stale, 0 downgraded, 0 new edges
  against `architecture-edges-baseline.json`.
- Zero `vscode` imports in any of the 15 VS Code-free zones.
- Zero `bus.emit` repo-wide. The four `appSignals.emit` sites in `src/tools/`
  ride the baselined `tools -> eventBus` edge; `src/controllers/` emits only
  through `SessionHandle.events` / `interactions`.
- No hand-rolled `chain = chain.then(...)` accumulators in
  `packages/cli/src/runtime/**` or `packages/desktop/src/main/**`, and no local
  reimplementations of `.at()`, `.toSorted()`, `Object.hasOwn`,
  `structuredClone`, or `node:timers/promises` `setTimeout`. One hand-rolled
  single-flight drain remains at `packages/cli/src/runtime/logSinks.ts:196-292`
  (`NdjsonStdoutSink`), which is stdout-backpressure handling rather than a
  task queue — `p-queue` does not cover it.

## 3.3 Correction: two candidates did not survive implementation

Recorded because the errors are more instructive than the finds.

**`StreamArtifactProjection` — right finding, wrong fix (#11396 closed, superseded by #11400).**
§3 listed the module as wrong-layer with a false docstring. Both were true. But
the fix — moving it into the CLI — treats a symptom. The module exists because
`StreamSnapshotStore` **clones on read**: `getOutputFiles`,
`getMissingOutputs`, and `getCompileFailures` each return
`cloneRoundIndexed(...)` (a new object plus a new array per round), and
`getRunUsage` returns `new Map(...)`. Ink repaints per streaming token, so
reading the store directly would re-clone every round map and re-sum usage on
each repaint. `projectStreamArtifacts` + `artifactProjectionMemo` exist to
amortize that, and the memo's own comment says so (#10731).

Every production caller of those four accessors is read-only — verified by
grep for `.sort(`/`.push(`/`.splice(`/`.reverse(` on the round maps and
`.set(`/`.delete(`/`.clear(` on the usage map: zero hits. So the defensive copy
protects against nothing, and returning readonly views collapses the projection
entirely while also stopping both GUI hosts cloning per render pass. That is
#11400.

The audit found the symptom and missed the cause, which was findable at survey
time. **Generalizable rule: for a "wrong layer" candidate, establish why the
thing exists before proposing to move it.** A misplaced module is often a
workaround for something upstream, and relocating it entrenches the workaround
while looking like progress.

**The `ToolHost` `'cli'` arm is not dead (#11390 closed).**
The audit reported that `buildToolDashboardItems` is never called with
`'cli'`. True — but that is the _dashboard builder_, not the type arm. Five
tools declare a `cli` exclusion that `isDefaultToolUnavailableOnHost` reads
(`SendToTerminalTool.ts:54`, `InstallVscodeExtensionTool.ts`,
`InvokeCommandTool.ts`, `InlineCommentTool.ts`,
`ExternalInquiryTool.ts:249-254`), and the CLI passes `'cli'` at
`packages/cli/src/runtime/tools.ts:40`. Nothing is removable. The fold was
separately rejected on cost; #11397 took the only real residue.

## 4. Rejected, with reasons

Recorded so the next sweep does not re-raise them.

- **A shared cross-host run-launch assembler.** Already shared where it can be;
  further convergence needs a webview-message port the CLI must fabricate.
  Adds LoC — rejected on direction.
- **Merging the per-host interaction registries.** Ruled in
  `2026-08-03-ssot-consolidation-plan.md` §0.1 item 8: per-host interaction
  registries are the deliberate resting state (HOST-2).
- **Merging `ApprovalRequestHandler`'s registry with the host settle maps.**
  A16-fenced; attempted and reverted twice, NET_LOSS-adjudicated.
- **Collapsing `sessionProgressSubscription.ts` into the applier.** Frozen
  public NDJSON wire; the re-projection is cited approvingly as an exemplar.
- **The projection-zero `SessionRendererPort` narrowing.** Explicitly gated on
  two named maintainer supersessions plus a bandwidth measurement.
- **Unifying the retry-rollback machinery.** On the explicit do-not-do list,
  and the two rollbacks are not behavior-equivalent (aggregate-all vs
  throw-first), so unifying picks a winner — a feature decision.
- **Merging the CLI and desktop update checkers.** Residual shared logic ≈ 0
  lines; npm dist-tag + Homebrew versus the GitHub releases API.
- **Unifying the three OAuth callback transports**, or moving pending-nonce
  storage in either direction. Platform boundary and security boundary
  respectively.
- **PKCE `flowId` binding and desktop nonce-shape validation.** Real gaps, but
  hardening is not simplification — routed to security review, not proposed
  here.
- **`SettingsAgentControllerFactory`.** Two production callers, four class
  constructions, six closures over host state. Passes the factory ban's
  exemptions outright.
- **Relocating `MainViewDroppedFilesController.ts`.** Single-consumer, but
  moving it relocates 130 lines and deletes zero.

## 5. Acceptance criteria

1. §4 of `2026-08-15-single-substrate-hosts-as-renderers.md` records
   `contextState` and `runStartedAt` as landed, with the HEAD anchors above.
2. `thinkingActive` is marked withdrawn with the `compactingActive` rationale,
   or implemented with an explicit ruling that overrides it.
3. Each row in §3 is either filed, landed, or rejected in writing.
4. No change in this document's scope widens
   `config/ratchets/host-agent-import-baseline.json` or
   `architecture-edges-baseline.json`; any PR that deletes a host's last
   `@agent/*` deep import prunes the baseline in the same commit.
