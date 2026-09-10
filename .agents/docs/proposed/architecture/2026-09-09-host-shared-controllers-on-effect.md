# Host controllers on Effect: what is actually triplicated, and what to collapse

Status: proposed — a study of the three hosts' Promise-shaped controller
surface, with a conversion sequence. This assesses
`claude/effect-compat-layer-removal-e0pi42` at `487f5c1`.

The premise under test is the owner's judgement that
`packages/cli`, `packages/desktop` and `packages/extension` have
independently reimplemented the same controllers and data structures, and
that the Effect conversion should collapse that triplication rather than
convert three copies. The premise holds in four specific places and fails in
several others. Both results are recorded below, because a plan that converts
what is already single-authority is more expensive than one that does not.

The rules that bound every proposal here are the repository's own: the VS
Code-free zones and the host-neutral home in
[CLAUDE.md](../../../../CLAUDE.md), the R1 boundary and the shrink-only
baselines in
[`config/ratchets/`](../../../../config/ratchets/effect-migration-baseline.json)
enforced by
[`check-effect-migration-ratchet.mjs`](../../../../scripts/check-effect-migration-ratchet.mjs),
and the owner's 2026-09-06 ruling that there are no temporary adapters.

## 1. The finding

### 1.1 Where the triplication is real

Four capabilities are genuinely written more than once, each demonstrated by
reading both copies rather than inferred from filenames.

**The decision-to-wire mapping for approvals.** One UI decision becomes a
`policy.set` bypass arm plus a `decision.*` runtime arm, and that mapping
exists twice. `decisionArms` at
[`BaseRequestPanel.ts:30-198`](../../../../packages/extension/src/progressView/frontend/components/BaseRequestPanel.ts)
builds
`{ kind: 'policy.set', change: { field: 'bypass', streamId, bypass, enabled: true } }`;
`bypassRequest` at
[`approvalQueue.ts:343-354`](../../../../packages/cli/src/chat/tui/state/approvalQueue.ts)
builds the identical literal. Both then emit
`[bypass, decision.bash]` in that order, and both carry a function named
`userQuestionDecision` producing the same `decision.userQuestion` shape. The
desktop is not a third copy: its renderer imports the extension's panels
(`packages/desktop/src/renderer/main.ts:20,24`).

The two copies have drifted in ways that are not presentation choices. The
CLI's `rejection()` (`approvalQueue.ts:356-368`) collapses
`rejectionCause ?? rejectionReason ?? userMessage` into a single `feedback`
string, discarding the provenance distinction that
[`HostInteractions.ts:257-274`](../../../../src/agent/runtime/HostInteractions.ts)
`classifyRejection` reads. The CLI sends plan `autoApproveAll`; the extension
does not, though the schema supports it. The CLI settles external inquiries
by calling `handleExternalInquiryAction` directly from its host hook
(`subscribeApprovals.ts:813-816`) rather than through the
`externalInquiry.submit` / `.drop` arms that
[`SessionRequests.ts:384-416`](../../../../src/controllers/session/SessionRequests.ts)
routes to the same function.

**The quota-exhausted credential switch.** The shared, Effect-native
implementation is
[`ProgressApiKeyRetryController.ts`](../../../../src/controllers/progressView/ProgressApiKeyRetryController.ts):
a `Semaphore.makeUnsafe(1)` routing lane at `:70` held across the commit at
`:189-193`, disables applied before the action at `:246-247`, and
`Effect.addFinalizer` rollback at `:229-244` guarded by
`Exit.isSuccess(exit) && exit.value === true`. Both webview hosts reach it in
one line each. The CLI carries a second implementation of the same policy in
[`subscribeApprovals.ts`](../../../../packages/cli/src/chat/tui/state/subscribeApprovals.ts):
`new PQueue({ concurrency: 1 })` at `:162`, a hand-rolled
`rollbackChangedSettings` at `:507-527`, `codingPlanRollbackConfig` at
`:536-556` and `throwWithRollbackFailures` at `:560-572`. Both operate on the
same runtime table.

**The composition-root bootstrap sequence.** Ten shared calls appear in the
same order in three files, and the hosts assert the parity they cannot
enforce:

| Call | CLI | Desktop | Extension |
| --- | --- | --- | --- |
| `initProcessSettingHost` | `initPlatform.ts:344` | `platform/index.ts:178` | `extension.ts:413` |
| `installTexraAccountProbes` | `:347` | `:181` | `:524` |
| `refreshModelListAndLog` | `:354` | `:207` | `:641` |
| `seedDisabledToolDefaults` | `:378` | `:226` | `:570` |
| `initNodeAgentRuntime` | `:389` | `:235` | deliberately omitted |
| `registerRuntimeShutdownHandlers` | `:398` | `index.ts:1637` | `:540` |
| `UsageLogService.initialize` | `:419` | `:190` | `:670` |
| `initializeBundledPrompts` | `:441` | `:239` | `:482` |
| `bootstrapNodeAgentDirectories` | `:444` | `:244` | `:621` |
| `initializeNodeRuntimeSkills` | `:452` | `:241` | `:562` |

`packages/cli/src/runtime/initPlatform.ts:352` says "as the extension and
desktop hosts do at startup"; `packages/desktop/src/main/platform/index.ts:224`
says "Mirrors the extension's ordering". Those comments did not prevent the
drift they were written against: `UsageLogService.dispose()` sets
`this.config.enabled = false`
([`UsageLogService.ts:551`](../../../../src/telemetry/UsageLogService.ts)),
and it is registered in a different position in each host — the desktop
registers it directly on `SHUTDOWN_PHASE.BEFORE` at `platform/index.ts:197`,
the extension in `afterAgentShutdown` at `extension.ts:543`, the CLI in
`afterFlushArtifacts` at `initPlatform.ts:404`. Handlers run in registration
order within a phase, so the desktop has the widest window for dropping
queued usage and plan-accounting records, while its own comment at `:188`
claims it disposes "from the same BEFORE phase the other two hosts use".

**The credential and onboarding refresh loops.** The post-credential-change
fan-out is written twice —
`SettingsViewMessageHandler.ts:627-668` and
`desktopCredentialSettingsController.ts:390-399` open with the same two
statements verbatim (`invalidateApiKeyCache()`, then
`codingPlanForApiProvider(provider)?.usageProvider`) and run the same five
steps, diverging on whether Profile data is reposted. The onboarding funnel
refresh is written twice —
`ProgressViewProvider.ts:397-431` and `desktopOnboardingIpc.ts:100-132` are
the same five steps in the same order (probe in a try with a near-identical
"Credential probe failed; treating as no credential" warning, plan the
transition, store it, publish, `clearDeclined`, `selectSetupAgent`), both
holding a private `previousFunnelState` and both wrapped in the same shared
`OnboardingRefreshQueue`. Three small credential paths are written three
times: [`providerApiKey.ts`](../../../../packages/cli/src/runtime/providerApiKey.ts)
is a byte-equivalent copy of `SettingsProfileKeyController.storeProviderKey`
minus its `isApiProvider` guard and its failure report, and
[`githubToken.ts`](../../../../packages/cli/src/runtime/githubToken.ts) is a
25-line third copy of set/remove/status over the same shared
`resolveGitHubTokenSource` and `GITHUB_TOKEN_STORAGE_KEY`.

### 1.2 Where the triplication claim did not hold

This is the more useful half of the finding.

**The session view and transcript are already single-authority.** `fold` has
exactly one importer repo-wide —
[`SessionView.ts:31`](../../../../src/controllers/session/SessionView.ts). There
is one `SessionView` type, one `toSignal` bridge
([`signals.ts`](../../../../src/shared/signals.ts)), and all three hosts use
them. `src/shared/session/**` contains zero `async`, zero `await`, zero
`.then(`, zero `p-queue`/`p-defer`/`AbortController` and zero ratchet rows.
There is nothing to convert there and nothing to collapse.

**The desktop is not a third UI.** `packages/desktop/src/renderer/main.ts:20,24`
and `projectWorkbench.ts:6` import `@progressView/frontend/ProgressApp` and
`createSessionSurfaces` from the extension package. Every finding about the
approval panels, the composer, the surface record and the transcript renderer
lands on the extension once, not twice. The duplication in the presentation
layer is a duplication of two, and the second copy is always the CLI.

**The run lifecycle already has one home each.** `runAgent`, `executeAgent`,
`AgentRunLifecycle`, `ExecutionRegistry`, `ExecutionLanes`,
`resumeStream`/`resumeRun`, `settleLiveSessionExecutions`,
`detachSubagentsOnStop`, `closeSession`, `hostRunActions` and
`registerRuntimeShutdownHandlers` each have exactly one implementation that
all three hosts call. No shared lifecycle controller needs to be built. The
work there is conversion, not collapse, with two localised exceptions (the
desktop's private project-close loop and the extension/desktop resume latch).

**The settings-view handler registries are composition roots, not copies.**
`SettingsViewMessageHandler.ts:250-430` and `desktopSettingsIpc.ts:422-486`
look like twins, but the command union, the dispatcher, the snapshot builder,
the state-setting writer and every non-trivial handler body already live once
in `src/shared/settingsView/` and `src/controllers/settingsView/`. What remains
per host is a binding table mapping command names to host-owned closures.
Collapsing them collapses the composition root.

**Several things that share a primitive do not share a concern.** The three
`p-queue` instances in the composition roots serialize API-key status refresh
(`extension.ts:788`), diff temp-dir disposal (`desktop/main/index.ts:192`) and
follow-up delivery (`runChatTui.tsx:353`). The three exit paths —
`sessionExitController.ts`, `desktopWindowLifecycle.ts`, `shutdownExtension()`
— are a terminal, an Electron quit with a renderer veto, and a VS Code
`deactivate` that may be re-entered. The one shared decision among them, the
settle/flush/dispose ordering, is already owned once by
`registerRuntimeShutdownHandlers`. Building a controller over any of these is
a net loss.

**Approval presentation is genuinely different product.** The webview shows
every pending request at once in a grouped dock; the TUI shows exactly one, and
needs the promotion and presentation-order machinery at
`approvalQueue.ts:200-283` that the webview has no counterpart for. The
per-kind renderers are exhaustive switches over the same shared union, which
the repo builds that way on purpose.

## 2. The shared controller layer

Only the pieces below are proposed. Each states what it subsumes, and each is
constrained by the fact that `src/controllers/**` and `src/shared/**` sit
*below* the R1 boundary: a shared controller returns `Effect` and contains no
`Effect.run*`, because the register of below-boundary run sites is closed —
`check-effect-migration-ratchet.mjs:1318-1335` filters `--update` output to
files the committed baseline already names.

### 2.1 `approvalDecisionArms` — a pure module, not a controller

Home: `src/shared/session/approvalDecision.ts`.

There is no async in either existing copy, so this is a function, not a
service. Input: a `PermissionPayload`, a decision, and a two-field capability
record (`toolEditPreview`, `ownApiKeyRetry`) that carries the two *deliberate*
host differences as data rather than as a fork. Output:
`readonly ApprovalArm[]`, where
`ApprovalArm = { runtime: RuntimeRequest } | { host: HostRequest } | { settle: HostSettlementIntent }`
— the first two are the private `type Arm` at `BaseRequestPanel.ts:22-23`, the
third names what the CLI does when its own hook holds the latch.

It must live in `src/shared/session/`, not `src/controllers/`: the extension's
progress-view frontend is a browser bundle that already imports
`@shared/session/hostRequest` and `@shared/session/runtimeRequest` directly.

Ports: none. It reaches `@shared/schemas`, not past it, so the
`shared-schemas-deep-import` baseline — whose `forced` and `gratuitous` lists
are empty — is untouched.

Subsumes: `decisionArms` and `userQuestionDecision`
(`BaseRequestPanel.ts:30-198`, `:200-207`), the decision vocabulary in
`packages/extension/src/progressView/frontend/events.ts:17,28,48-96`, and the
CLI's `ApprovalDecision`, `bypassRequest`, `rejection`, `DecisionOf`,
`planDecision`, `userQuestionDecision` and the per-kind arm construction inside
`decideRequest` (`approvalQueue.ts:74-87, 343-476`).

It does **not** subsume `approveQueuedDelegatedWorkForStream`
(`approvalQueue.ts:572-591`), a CLI-local recursive sweep over the TUI's own
host-reservation registry that `decideRequest:462` triggers on a super-YOLO
proposal approval. That has no extension counterpart and stays CLI-side; the
surviving `decideRequest` dispatches the shared arms and then calls it.

Naming: `ApprovalDecision` is already an exported type at
[`prompts.ts:168`](../../../../src/shared/schemas/prompts.ts), re-exported
through the schemas barrel and imported under that name by
`packages/cli/src/runtime/approvalAdapter.ts:17`. The new per-kind union needs
a different name.

### 2.2 `toolEditApprovalDrain` — the session-event drain only

Home: `src/controllers/approval/`.

The original proposal was for a `ToolEditApprovalController.attach` that also
acquired `session.interactions.use({ requestToolEditApproval, cancel })`
through `Effect.acquireRelease`. **That is impossible and has been dropped.**
`SessionHostInteractions` holds one active attachment —
`activeAttachment` is `attachments.at(-1)`
([`HostInteractions.ts:789-791`](../../../../src/agent/runtime/HostInteractions.ts))
— every capability accessor reads only that one, and
`activateCurrentAttachment` calls
`previous.interactions.cancel({ cause: 'Interaction host changed.' })` on
whatever it displaces (`:855-868`). A second `use()` would either blank the
extension's four VS Code arms and the desktop's `emit`, or displace the
tool-edit arms, and in either direction it fires a cancel on live approvals.
Both hosts pass every arm in one `use()` call for exactly this reason
(`ProgressViewProvider.ts:246`, `desktopAgentExecution.ts:175-180`).

What survives is small and honest: a scoped
`Stream.runForEach(session.events.all(session.now()), ...)` drain owned once.
Even that is worth less than it first looked. The extension's chime is inside
the *same* `Effect.sync` callback as `handleSessionEvent`
(`ProgressViewProvider.ts:209-222`), so splitting it gives the extension two
drains and two interrupts where it has one of each. The two hosts also already
tear down in opposite orders: the extension pushes the interrupt disposable at
`:223` and `detachHostInteractions` at `:279`, so it interrupts first, while
`desktopAgentExecution.ts:216-220` detaches first. There is no shared
invariant to preserve.

Conclusion: the extension is dropped from this step. What remains is the
desktop's `toolEditAction` pass-through
(`desktopAgentExecution.ts:208-214`, three arguments forwarded to
`handleAction` and nothing else) and the host arm that only calls it
(`desktopHostRequests.ts:711-717`), which the repo's own abstraction rule
bans and which the extension already does directly
(`extensionHostRequests.ts:761-767`). Deleting those is a real, contained win.

If a controller-owned attachment is genuinely wanted later, that is a change
to `SessionHostInteractions` composition semantics and must be proposed as
such.

### 2.3 `ProgressApiKeyRetryController` — the CLI adopts the existing controller

Home: unchanged, `src/controllers/progressView/`.

The controller is already the right shape. Two things must change *before* any
host adopts it, both refuted findings against the original plan:

1. `QuotaFallbackRuntime.setEnabled` is typed `(enabled: boolean) => Promise<void>`
   ([`quotaFallbackRoutes.ts:17-22`](../../../../src/model/quotaFallbackRoutes.ts))
   and the controller calls it through `hostPort` with no check. The CLI's
   OAuth branch reads the write's result and fails loudly when the preference
   is still effective: `subscribeApprovals.ts:613-617` throws
   `"<label> subscription remains enabled by a more specific setting."`
   Adopting the controller as written would let a CLI retry proceed silently
   onto the exhausted credential — the repository's own "silent degradation is
   a defect" case. `setEnabled`/`restoreEnabled` must return the effective
   state and the controller must fail on a non-effective disable.

2. The CLI deliberately separates abandoning the wait from letting the commit
   finish. `runRetryTask` (`:269-295`) races an abort against a *detached*
   `start()` promise, and the code says so twice — "The task still runs, and
   stops at the checks below" at `:711` and `:745` — which is what guarantees
   the coding-plan rollback executes. Fiber interruption is the opposite.
   The commit and rollback region must be `Effect.uninterruptible`, with only
   the outer wait interruptible.

One new optional dep, `onRoutingChanged?`, carries the TUI's signal bump
(`subscriptionPreference.ts:27-36`); two callers, so it clears the dependency
bar.

Subsumes, in the CLI: the `p-queue` import and `retryCredentialCommitQueue`,
`runRetryTask`, `prepareRetryClient`, `rollbackChangedSettings`,
`codingPlanRollbackConfig`, `throwWithRollbackFailures`, `oauthCliPreference`,
and `switchRetryToPersonalCredentials` + `applyRetryCredentialCommit`.

Not subsumed, and preserved host-side: the auto-switch that skips the modal
for coding-plan quotas when a personal key exists (`:120-132`), its
`notify('credentialSwitched')`, and the per-request wording carried on
`request.tui.missingPersonalApiKeyMessage` (`:360-384`, `:679-682`), which the
shared `promptForApiKey(provider)` port cannot express.

### 2.4 `CredentialStore`, `credentialChanged`, and the credential controllers

Home: `src/controllers/credentials/`.

`CredentialStore` is a `Context.Service` carrying `PlatformSecrets`, modelled
on [`WorkspaceRoots.ts`](../../../../src/controllers/session/WorkspaceRoots.ts).
Its only job is to end the `platform().secrets` re-entries: 25 of the
repository's 51 ratcheted `platform()` call sites are in this area, and every
one re-reads a value the composition root already built. The desktop's
settings files already have zero — they thread `options.secrets` — so this
generalizes an existing host's pattern rather than inventing one.

`credentialChanged(kind)` is one `Effect.fn` over a plain in-process union
(`providerKey | subscriptionAuth | providerSetting | gitHubToken`), serialized
by `Semaphore.makeUnsafe(1)`, taking a `CredentialSurfaces` port record whose
every field is an `Effect<void>` so a host without a surface supplies
`Effect.void`. `invalidateApiKeyCache()` moves inside it, ending the five
scattered call sites. It subsumes the six duplicated fan-out methods and
supplies the missing seventh (the CLI's).

`ProviderKeyController` is `SettingsProfileKeyController` converted and moved
out of `settingsView/` — the CLI has no settings view, which is exactly why it
wrote its own copy. `githubToken.ts` is three one-liners over shared
vocabulary, collapsed.

Ports: `PromptHost` (type-only, already the controller's dep),
`ExternalOpener`, `CredentialSurfaces`. **No new Platform port anywhere in this
proposal** — `PlatformSecrets`, `StateStore` and `ConfigProvider` already
exist.

### 2.5 `bootstrapNodeHost` — phase two only

Home: `src/controllers/bootstrap/nodeHostBootstrap.ts`.

One `Effect.fn` owning the *order* of the ten calls tabulated in §1.1, run
once per host with a single `effectRuntime().runPromise` at each composition
root (an R1 boundary kind, uncounted).

Two hard boundaries, both verified:

- Phase two starts at `initProcessSettingHost`. `initPlatform` and
  `initProcessWorkspaceRoots` may only be imported by the five files in
  `COMPOSITION_ROOT_FILES` (`eslint.config.mjs:42-53`), so the shared program
  can never own them. The original design listed `createNodePlatform` among
  its calls while also saying platform creation stays per host; the former is
  wrong.
- `controllers -> telemetry` is not an edge in
  [`architecture-edges-baseline.json`](../../../../config/ratchets/architecture-edges-baseline.json)
  (only `agent -> telemetry` exists), so `UsageLogService.initialize`/`dispose`
  arrive as a two-field port. The shared program owns the phase position,
  which is where the drift is.

### 2.6 `SessionResumeController`

Home: `src/controllers/session/SessionResumeController.ts`. The only wholly
new controller file in this proposal.

The per-attempt monotone cancellation latch is written twice —
`resumeFromResumeData.ts:31-37` and `desktopAgentResume.ts:69-75`, the same
construction under two names — and both then call the same shared
`resumeStreamWithRefusalNotice`. The failure presentation has drifted: the
desktop classifies and emits through `session.interactions`, the extension
calls `vscode.window.showWarningMessage`.

One correction to the original design: `resumeFromResumeData.ts` is 70 lines,
not 69, and it does not only hold a latch. It also owns
`trackTerminalResultPresentation` (`:24-27`) and reports the warning through
`terminalResult.reportUnhandled` (`:61`), a guard that suppresses the warning
when the terminal-result toast already fired
([`terminalResultToast.ts:33`](../../../../src/agent/runtime/terminalResultToast.ts)).
Adding a classified `interactions.emit` path on top of an existing toast, while
deleting the double-surfacing guard, would make the extension report the same
failure twice. That guard must be named and given a home before this step.

### 2.7 Shared data structures

| Structure | Home | Subsumes |
| --- | --- | --- |
| `ApprovalArm`, per-kind decision union | `src/shared/session/approvalDecision.ts` | `type Arm` (`BaseRequestPanel.ts:22`), `PermissionDecisionByKind` (`events.ts:48-96`), `ApprovalDecision`/`DecisionOf` (`approvalQueue.ts:74-87, 370-373`) |
| `sessionActivity(view)` | `src/shared/sessionTitle.ts` | `desktopWindowTitle.ts:22-25`; the fold half of `terminalTitle.ts:69-84` |
| `STREAM_GROUP_LABELS` / `_ORDER` | `src/shared/streams/streamStatusDisplay.ts` | `StreamTabs.ts:53-59`; the inline switch in `cliState.ts:173-186` |
| `describeRequestRefusal` | `src/shared/copy/requestRefusal.ts` | `ProgressApp.ts:215-231` (drops `ref`), `transcript.ts:221-234` (drops `docsCommand`) |
| `CredentialChangeKind`, `CredentialSurfaces` | `src/controllers/credentials/` | six untyped fan-out methods |
| `PendingOAuthState` (Zod, strict, nonce-validated) | `src/auth/pendingOAuthState.ts` | `desktopSupabaseAuth.ts:45-49` (non-strict, unvalidated nonce) and the extension's twin |

The `SurfaceStore` proposed for the CLI's selection and expansion state
survives, with one amendment. It cannot require `SessionViewService`: the CLI
has zero references to it anywhere and bridges a raw
`SubscriptionRef<SessionView>` off the handle
(`packages/cli/src/chat/tui/state/sessionView.ts:40-49`). The store takes a
`Stream<SessionView>` argument instead. It also cannot silently absorb the
extension's watcher, which additionally drives transcript re-subscription and
is gated on a transport-replay fact (`sessionSurfaces.ts:155-157`) a
host-neutral store cannot see, and it should not take `drafts` until a
controlled Lit text input is shown to survive the `SubscriptionRef` → Stream →
signal hop. Scope it to selection, expansion and phase.

One placement rule must be settled, because the areas contradicted each other:
§2.1 argues a wire mapper belongs in `src/shared` to keep Node-reachable
controller code out of the webview bundle, while `SurfaceStore` is placed in
`src/controllers` on the grounds that `sessionTransport.ts:17` already imports
`@controllers/session/webviewSessionLayer`. The second observation is correct
and the first is over-cautious; `src/controllers` is reachable from the webview
today. The mapper still belongs in `src/shared` — it is a wire contract, and
`src/shared/session/` is where the contracts it maps between live — but not for
the bundling reason.

## 3. What each host keeps

**Extension.** Rendering, command registration, the settings binding table,
and one `effectRuntime().runPromise` per registry arm. The Lit approval panels
are untouched and stay free of async machinery entirely: zero `async`
functions, zero promises, zero `Effect.run` across `BaseRequestPanel`,
`BaseApprovalPanel`, `BaseBypassApprovalPanel`, `RequestPanels` and every
per-kind panel. Also unchanged: Copilot model access, inline criticism, LaTeX
Workshop install, `SupabaseAuthProvider` as a `vscode.AuthenticationProvider`
with its per-nonce multi-window pending storage, the `secrets.onDidChange`
listener, the four VS Code-only interaction arms, the two-port bridge attach,
and `shutdownExtension`'s re-activation idempotency.

**Desktop.** Rendering (which for approvals means the extension's panels),
the Electron quit path with its renderer veto, per-project session scoping,
`DesktopPromptController`'s correlated renderer prompts, the N-sessions
registry, the `hasAuthoritativeStream` pre-check in resume, and
`selectSetupAgent` as a documented no-op. It loses the `toolEditAction`
pass-through.

**CLI.** Rendering, terminal ownership, and everything the study confirmed is
genuinely CLI product behaviour: the whole of `sessionExitController.ts`, the
single-root-run slot and process exit code, the headless shutdown drain with
its `LaunchVerdict` and `texra resume` handshake, the one-at-a-time modal
presentation with its promotion ordering, the serial stdin lane (already fully
Effect-native via `withPerKeyLane`, with zero run sites — the in-tree proof
this direction works), the local-notice transcript, the Ink scrollback
machinery, `loadCliStartupConfig`'s pre-platform bootstrap, and the
`approveQueuedDelegatedWorkForStream` sweep.

## 4. Conversion order

Every step below is independently shippable unless marked otherwise. The
ratchet column names rows in
[`effect-migration-baseline.json`](../../../../config/ratchets/effect-migration-baseline.json);
a shrunk count must be regenerated with `--update` in the same PR, because
stale headroom fails the check as surely as growth does.

| # | Step | Ratchet | Risk |
| --- | --- | --- | --- |
| 1 | One decision vocabulary and arms mapper in `src/shared/session/approvalDecision.ts`; both surfaces call it | none | medium surface area, compiler-checked |
| 2 | `sessionActivity`, `STREAM_GROUP_LABELS`, `describeRequestRefusal` get their shared homes; delete `Surface.scroll` | none; knip consumers in the same PR | low |
| 3 | Delete the desktop `toolEditAction` pass-through and its host arm | none | low |
| 4 | `CredentialStore`; move and convert `ProviderKeyController`; delete `packages/cli/src/runtime/providerApiKey.ts` | `platform()` shrinks by 4 | medium-low |
| 5 | `githubToken` controller; delete the CLI file and the extension's single-caller alias | `platform()` shrinks by 6 | low |
| 6 | `SubscriptionUsage` as one scoped service | `platform()` shrinks by 2; retires `coalesceAsync` and `AbortSignal.timeout` | medium |
| 7 | `credentialChanged` fan-out; delete the six host copies | `platform()` shrinks by 2 | medium |
| 8 | Subscription sign-in/out sequence onto the existing catalog | `platform()` shrinks by 3 | medium-high: changes policy |
| 9 | Onboarding funnel loop absorbed beside its planner | possibly `catch:effect-importer` on `ProgressViewProvider.ts` — verify before regenerating | low |
| 10 | Shared pending-OAuth schema and nonce validation | none | low |
| 11 | Widen `QuotaFallbackRuntime.setEnabled` to report effective state | none | low, but gates step 12 |
| 12 | CLI adopts `ProgressApiKeyRetryController` | `import:p-queue` −1, `new AbortController()` −1, **`catch:effect-importer` must reach 0 in `subscribeApprovals.ts`** | high |
| 13 | `ExecutionRegistry.waitForAnyChange` → `settled(ids): Effect<void>` | none directly; prerequisite for the `sessionLayer` row | low |
| 14 | `ExecutionLanes` on `Deferred` | `import:p-queue` −1, `import:p-defer` −1 | moderate |
| 15 | `SessionHandle.flushArtifacts` / `settlePublications` as Effects | `import:p-defer` −1, `Effect.run*` `SessionHandle.ts` 3→2, `catch:effect-importer` 3→2 | high |
| 16 | Desktop project close calls the shared close | none | moderate — see below |
| 17 | `SessionResumeController` and Effect-typed `AgentResumePort` | `platform()` `hostRunActions.ts` 3→2 | moderate |
| 18 | `bootstrapNodeHost` phase two; CLI and desktop adopt | `platform()` may shrink; verify | medium |
| 19 | Extension adopts `bootstrapNodeHost` | `import:p-queue` −1 available | high |

**Steps that cannot ship alone.** Step 12 depends on step 11: adopting the
shared controller before `setEnabled` reports its effective state trades the
CLI's loud failure for silence. Step 19 depends on step 18. Steps 7 and 12
both touch `subscribeApprovals.ts:686`, where the comment at `:683-685` records
an ordering rule — "The presentation check is deliberately cached. Drop that
cache only after the uncached commit check" — that neither step's carry-across
list named; one step must own that region and the other must depend on it.

**Two ratchet corrections folded in.** Step 12's original claim that
`platform()` in `subscribeApprovals.ts` drops 2→1 is wrong: the controller has
no secrets access, `hasUsableKey` is an injected dep, so the read either stays
or relocates to another CLI file, which would be a *new* file on the
`platform()` row. And both step 12 and the abandoned attach step would have
added a runtime `effect` import to a file with raw catches and no such import
today — `subscribeApprovals.ts` has eight catch clauses and
`ToolEditApprovalController.ts` four, and neither file is in the
`catch:effect-importer` row. `--update` will not admit them. Step 12 must
convert all surviving catches to `Effect.catch` in the same PR.

**Step 16 needs three amendments before it is safe.** The desktop's
`close(root)` receives the canonicalized *workspace* path
(`desktopProjects.ts:249`), while `heldSession` matches on
`candidate.storage === root` (`sessionLayer.ts:582-588`) and the project's key
is a separate `WorkspaceStorageProvider(...).getStoragePath()` (`:255-257`).
Passing `root` yields `NOTHING_TO_CLOSE` and closes nothing; the step must pass
`project.key`. Second, on the budget-expiry path `closeSession` deliberately
does *not* invalidate the entry — it leaves it with `closeAdmissions()` applied
and warns (`sessionLayer.ts:701-717`) — which is correct for process shutdown
but wrong for a host that reopens the same project in the same process; the
desktop needs a caller-supplied budget, or should adopt only `closeAdmissions`
and the report. Third, the desktop's own comment at `:294-295` states that the
stop must happen "while the registry still owns the project", so the shared
close cannot run before the bookkeeping that removes it from `projects`.

**Step 14 is not the like-for-like swap the design claimed.**
`withPerKeyLane`'s lane is `{ tail: Deferred<void>, fibers: number }`
([`perKeyQueue.ts:64-67`](../../../../src/utils/core/perKeyQueue.ts));
`ExecutionLane` additionally holds `live`, a hold installed by a non-entrant
through `holdLive` (`executionLanes.ts:120-138`), and `waiting`, a refuse set
that `disposeAll` uses to actively reject admitted-but-unstarted steps
(`:141-149`). The busy predicate that raises `ExecutionBusy` reads
`lane.live !== undefined || queue.size > 0 || queue.pending > 0` (`:70-73`);
`fibers` is not that. The step converts to `Deferred` with an explicit `live`
hold and an explicit refusal channel, not to `withPerKeyLane`.

## 5. Deletions and net accounting

| Deleted | Location |
| --- | --- |
| `decisionArms`, `userQuestionDecision`, `type Arm` (~178 lines) | `BaseRequestPanel.ts:22-207` of a 239-line file |
| `PermissionDecisionByKind`, `PermissionKind`, `APPROVE_*` (~55 lines) | `events.ts:17,28,48-96` |
| CLI mapper half (~120 lines) | `approvalQueue.ts:74-87, 343-476` |
| CLI credential-switch copy (~270 lines) | `subscribeApprovals.ts:20,162,269-306,507-592,600-759` |
| Desktop `toolEditAction` + its host arm | `desktopAgentExecution.ts:208-214`, `desktopHostRequests.ts:711-717` |
| `Surface.scroll` in seven places | `surface.ts:132,161,195,216,260,420,518` |
| `packages/cli/src/runtime/providerApiKey.ts` | whole file |
| `packages/cli/src/runtime/githubToken.ts` | whole file, 25 lines, 3 ratcheted `platform()` |
| `SecretManager.gitHubTokenExists` | `secretManager.ts:35-37`, single-caller alias |
| Six credential fan-out methods | `SettingsViewMessageHandler.ts:627-676`, `desktopCredentialSettingsController.ts:375-413` |
| Two onboarding refresh loops and their `previousFunnelState` fields | `ProgressViewProvider.ts:397-431`, `desktopOnboardingIpc.ts:100-132` |
| `selectDesktopSetupModel`, `buildDesktopSetupExecuteMessage` | `setupLaunch.ts:142-161`, host-named single-caller helpers in shared code |
| Three redundant `SubscriptionUsageService` instances | `apiStatus.ts:30`, `StatusBar.tsx:69`, the `??` fallback |
| `resumeFromResumeData.ts` | whole file, 70 lines |
| Desktop `stopProjectExecutions` (~26 lines) | `desktopProjects.ts:154-179, 296-297` |
| Bootstrap phase-two bodies | three files |

Added: five files (`approvalDecision.ts`, `requestRefusal.ts`,
`CredentialStore.ts`, `credentialChange.ts`, `nodeHostBootstrap.ts`), one moved
file (`ProviderKeyController.ts`), one new controller
(`SessionResumeController.ts`), one new `src/auth` schema module, three Effect
services and four port records. Zero new Platform ports. No compatibility
layer, adapter or bridge anywhere: the Promise-port edge is `hostPort`
([`hostPort.ts`](../../../../src/common/hostPort.ts)), already used in seven
controller files, which does not run an Effect and so is not a boundary
violation.

`Surface.scroll` is confirmed dead: a repo-wide grep excluding
`scrollTop`/`Height`/`IntoView`/`To`/`Left`/`By`/`back`/`able`/`Width` returns
only `surface.ts:195`, `:216` and `:518` — persist, load, reducer. No reader
exists; the extension restores scroll through live DOM elements instead.

The honest headline is that this is net-negative but not dramatically so — on
the order of 800 production lines removed against 400 added — and that most of
the value is not line count. It is: two decision vocabularies becoming one,
two credential-switch implementations becoming one, three bootstrap sequences
becoming one order, six fan-outs becoming one, and roughly 25 of the 51
ratcheted `platform()` re-entries going to zero.

## 6. What this deliberately does not touch

The 1.0 retirement targets in
[section 5 of the implementation plan](2026-09-09-texra-1-0-implementation-plan.md)
are excluded: `src/agent/modelHandlers/`, `persistedFlow.ts`,
`ExecutionKVStore`/`KVStore`, `src/agent/storage/executionLease.ts`, and
`src/platform/defaults/jsonStore.ts`. Two consequences follow. The CLI's
`loadCliStartupConfig` sits on `JsonStore` and is left alone. And step 15's
context-plumbing work borders `SessionHandle.releaseExecutionLease`
(`:396-443`), which wraps `executionLease` calls — some of that work sits
around code slated for deletion, and the step should stop at the artifact
flush rather than follow the lease path.

Also untouched, with reasons already given in §1.2: the fold and the session
view; the frames transport; the three exit controllers; the three composition-
root queues; the settings binding tables; the TUI's one-at-a-time approval
presentation; the three OAuth sign-in presenters, already correctly factored
behind `SubscriptionSignInPresenter`; the pending-OAuth *storage*, which
differs because multi-window VS Code and a single Electron app genuinely
differ; and chat export, which is already shared through
`loadChatExportInput`.

Two Promise surfaces that look tempting and are out of reach from a
host-controller change: `HostInteractions`'s request latch
(`:818`) and the `p-queue` in `streamApprovalQueue.ts:162`. Making `enqueue`
return an Effect makes `requestBashApproval` an Effect, and its callers include
`src/tools/claudeAgent.ts` and `src/tools/agentCliShared.ts`, neither of which
is an R1 boundary kind. The run site that conversion needs cannot be admitted.
The same argument blocks converting `ToolEditApprovalController`'s settlement
latch. Those belong to the run-lifecycle lane.

`registerRuntimeShutdownHandlers` is host-neutral orchestration living in
`src/tools/agentCliSessionStores.ts`, which CLAUDE.md places in
`src/controllers/`. Its co-location rationale is stated at `:49-56`. That is a
relocation candidate, noted and not acted on.

## 7. Open questions

1. **Should `QuotaFallbackRuntime.setEnabled` report effective state?** Step 12
   is blocked on this. The alternative is that the CLI keeps its check
   host-side, in which case the "one implementation" claim does not hold and
   step 12 shrinks to deleting the rollback machinery only.
2. **Must a retry's credential commit survive cancellation?** The CLI's code
   says yes, twice. If so the commit region is `Effect.uninterruptible` and the
   `new AbortController()` row shrink is not free.
3. **Should subscription sign-out disable the routing preference?** The CLI
   does; the extension and desktop do not, so a signed-out user's
   `preferSubscription` stays on and the next sign-in silently re-enables
   subscription routing. Step 8 propagates the CLI behaviour. This is a
   behaviour change that needs sign-off, not a refactor consequence.
4. **Which shutdown phase should own `UsageLogService.dispose`?** Step 18
   should decide on the merits rather than preserve whichever host is copied
   first. The three positions and the `enabled = false` mechanism are
   established; a concretely lost record is not.
5. **Should the CLI's surface state persist across `texra` restarts?**
   `SurfaceStore` requires a `StateStore`, so selection, expansion and phase
   would survive a restart. The honest fix if that is unwanted is to scope
   `PersistedSurfaceSchema`, not to add a second storage shape.
6. **Should `USE_OPENROUTER` be cleared when a subscription preference is
   enabled?** The CLI does it (`modelAccessSelection.ts:126-129`); neither
   webview host does. The declarative mechanism exists
   (`stateSettings.ts:1531-1535` `onWrite.disablesWhenEnabled`) but cannot
   reach these two plain config keys. Propagate the behaviour, or make them
   catalog rows.
7. **Can the extension's ten bootstrap steps be pulled into one contiguous
   program without changing observable activation order?** Unproven; it gates
   step 19. `initVscodePlatform` must also remain callable twice per activation
   for the no-folder welcome path.
8. **Is the extension's omission of `runtimeUnavailableTools` at
   `executeCommand.ts:59-70` intentional?** No `'extension'` or `'vscode'`
   argument to `getDefaultUnavailableToolNames` exists anywhere in the tree.

## 8. Provenance

This study was produced by a fourteen-agent workflow: four capability maps
over the approvals, session-and-run-lifecycle, session-view-and-transcript,
and settings-credential-bootstrap surfaces, plus a fifth over the authority
side (ratchets and architecture tests); four area designs; three adversarial
reviews (architecture rules and ratchets; behaviour parity across hosts;
deletion accounting and hidden bridges); and this synthesis, which
independently re-verified the load-bearing claims against the tree at
`487f5c1`.

Findings that changed the design rather than being appended to it:

- **`ToolEditApprovalController.attach` owning `session.interactions.use` was
  dropped outright.** Two reviews found it independently; the single-active
  attachment and the displacement cancel are verified at
  `HostInteractions.ts:789-791` and `:855-868`. The step now covers only the
  desktop pass-through removal, because splitting the extension's chime out of
  the shared `Effect.sync` gives it two drains where it has one.
- **Desktop `closeSession(root)` was corrected to `closeSession(project.key)`,
  given a caller-supplied budget, and re-sequenced** after the key mismatch,
  the non-invalidating budget-expiry path and the registry-ownership comment
  were traced.
- **`ExecutionLanes` → `withPerKeyLane` was demoted** from a like-for-like swap
  to a `Deferred` conversion with an explicit `live` hold and refusal channel,
  after reading both lane records.
- **`SurfaceStore` stopped requiring `SessionViewService`**, which has zero CLI
  references, and was scoped away from drafts and from the extension's
  replay-gated watcher.
- **Two steps were found to add a runtime `effect` import to files with raw
  catches and no such import**, which the ratchet's closed-row `--update`
  refusal makes unfixable by regeneration. Both now carry an explicit
  catch-conversion obligation.
- **The `platform()` 2→1 claim for `subscribeApprovals.ts` was withdrawn** —
  the controller has no secrets access.
- **`approveQueuedDelegatedWorkForStream` and
  `trackTerminalResultPresentation` were added to the host-keeps set** after
  both were found inside ranges the design deleted wholesale.
- **The `allowBypass` step was kept but re-justified.** One review argued the
  stated user-visible change is unreachable, and that is correct: the queue's
  bypass check at `streamApprovalQueue.ts:158-163` and the prompt's
  `!isBypassed` at `bashApproval.ts:58` run with no yield between them, so a
  presented prompt always carries `allowBypass: true`. What remains real is the
  streamless case: `streamId` falls back to `''`, the extension's
  `Boolean(data.allowBypass && data.streamId)` hides the affordance, and the
  CLI's hard-coded `alwaysAllow` would offer it and emit `policy.set` with an
  empty stream id. The step adopts the full predicate.

Left unverified, and stated as such rather than asserted:

- Whether any registered artifact flusher reads ambient run context through
  `AsyncLocalStorage`, which gates step 15. Not enumerated.
- Whether a desktop project closed before quit actually loses a concrete
  artifact writer. The structural gap is real; a lost record was not
  demonstrated.
- Whether the desktop's earlier `UsageLogService.dispose` position loses a
  specific usage entry in practice.
- Whether the CLI's missing tool-availability re-probe after a GitHub-token
  write is user-visible; the read path was not traced.
- Whether the extension's failure to repost Profile data on an
  `invalidatesModelOptions` write is user-visible.
- Whether the rejection-provenance flattening at `approvalQueue.ts:356-368` is
  reachable. Bash, plan and proposal requests park rather than take a host
  reservation, so no path exercising the `cause`/`reason` branches was
  constructed. It is recorded as a latent collapse of a distinction the sibling
  adapter preserves, not a demonstrated defect.
- Whether a controlled Lit text input survives a `SubscriptionRef` → Stream →
  signal hop, which gates moving drafts into `SurfaceStore`.
