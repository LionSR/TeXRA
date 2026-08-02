# Agent SDK Readiness — Verification Checkpoint (2026-07-21)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the plan of record
[`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-18` checkpoints (most recently
[`-2026-07-18`](./2026-07-18-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against `main` at HEAD `3612630`
(v0.39.8) — one patch version above the `1f7082f` (v0.39.7) pin the 07-18
checkpoint recorded. As on every prior pass it ran a **fresh, uninformed
multi-way fan-out audit** — four separate readers for (1) `agent/core` +
`agent/runtime`, (2) `agent/modelHandlers` + `ModelFactory` + `IModelHandler`,
(3) `logger` + `trace` + `transcript` + the `SessionEventHub` path, and (4) the
host↔core surface (`platform`, `AgentRuntimeHost`, `HostInteractions`,
`src/hosts`, the three host wirings) — then reconciled every finding against
the adjudicated rulings and re-checked the tracked candidates against the
current tree.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The four fresh readers independently re-reached the
standing conclusion, and the spine anchors all hold at `3612630` (see
**Verified** below): `createModelHandler` + `PROVIDER_HANDLER_ROUTES`
(`ModelFactory.ts:426`,`:72`), `IModelHandler` still a `Pick<ModelHandler>`
(`src/agent/types/IModelHandler.ts:41`), `src/agent/core/index.ts` still absent
(no barrel regression), `emitRuntimeEvent` still retired (sole grep hit is the
retirement guard test), `RunScope` still the single `readonly` identity carrier
(`RunScope.ts:14-19`), and the `Node.exec → createFlow().run` shape intact
(`ResponseCycleNode.ts:104`; `ToolUseCycleNode.ts:101`). Every substantive
candidate the fan-out surfaced maps onto an **already-adjudicated trap** (ruling
held), an **already-tracked strategic / reviewed-train** item, or a **verified
false positive** — the recurring `src/`-only-grep methodology error struck
again (the core reader re-surfaced `bestConnectionMethodAnthropic` as "dead,
zero callers"; it is not — see below).

## Headline this pass — Step 0's enforcement ratchets have landed

The north-star's central open action was **Step 0 (R-a/R-b enforcement
ratchets)**, and every checkpoint through 07-18 still described it as pending
("this does **not** retire Step 0's R-a/R-b ratchets — width is still ~100
union specifiers and unfenced, so the freeze is still worth installing").
**As of `3612630`, both ratchets are installed and enforced:**

- **R-a (inbound freeze — `src/**` must not import host layers)** is live in
  `eslint.config.mjs` as `HOST_LAYER_RESTRICTED_IMPORT_PATTERNS`
  (`eslint.config.mjs:88-104`): a `no-restricted-imports` block forbidding
  production `src/**` from importing `@webview/**`, `@commands/**`,
  `@progressView/**`, `@settingsView/**`, `@frontend/**`, `@extensionSchemas/**`,
  `@resources/**`, `@common/state/**`, `@common/webview/**`, **`@cli/**`**, and
  **`@desktop/**`**. A sibling `AGENT_CORE_RESTRICTED_IMPORT_PATTERNS`
  (`eslint.config.mjs:106+`) additionally forbids `agent/core` from importing
  `@agent/modelHandlers` implementations — a boundary the north-star did not
  even ask for. Core→host alias violations remain **0** (measured), so the
  ratchet installed at a genuinely zero baseline exactly as the north-star
  predicted (§3).
- **R-b (width freeze — the frozen per-host deep-import baseline)** is live as
  `config/ratchets/host-agent-import-baseline.json`, enforced by the Vitest
  architecture suite `src/test-kernel/architecture/hostAgentDeepImportRatchet.vitest.ts`
  (which reads the baseline, recounts each host's distinct `@agent/*`
  specifiers, and fails when a host exceeds its pinned count). The baseline's
  own doc string states the R-b contract verbatim ("The ratchet fails only when
  a host's distinct-specifier count exceeds this baseline; a decrease … is
  welcome and should shrink this file"), citing issue #7684 R-b. Two companion
  baselines (`architecture-edges-baseline.json`, `host-agent-mock-baseline.json`)
  guard adjacent edges. (Note: `packages/cli/scripts/check-host-imports.mjs`,
  wired as the CLI `check:architecture` script, is a **separate** boundary
  checker — it enforces the CLI's `vscode`/`electron`-free + `process.*`-input
  boundaries, and does **not** read the `@agent/*` width baseline; an earlier
  draft mis-attributed R-b enforcement to it.) The `#9027` commit
  ("fix(desktop): preserve host import ratchet") shows the ratchet is actively
  catching regressions.

This resolves the north-star's "the boundary is eroding while unfenced" concern
(§3) — the width is no longer merely decelerating (the 07-18 signal) but
**fenced**, and the census below shows it is still actively shrinking under the
maintainers' consolidation train. Step 3 (packaging) remains gated on a real
external consumer; but Step 0 is **done**, not pending.

### Boundary width — still shrinking, now under the freeze

Distinct `@agent/*` deep-import specifiers per host (static `from` + dynamic
`import()`), recounted at `3612630`:

| Host                 | North-star baseline | 07-18 (`1f7082f`) | Now (`3612630`) | Δ vs 07-18 |
| -------------------- | ------------------- | ----------------- | --------------- | ---------- |
| `packages/extension` | 49                  | 44                | **41**          | −3         |
| `packages/cli`       | 35                  | 34                | **31**          | −3         |
| `packages/desktop`   | 27                  | 29                | **26**          | −3         |

All three hosts dropped this window. The CLI count (31) matches the length of
the checked-in `cli` baseline list exactly, confirming the R-b baseline tracks
the live surface. (This is an independent recount; ±1 vs a differently-tokenized
census is possible, but the direction — down on all three — is unambiguous.)

## Applied this pass — two verified dedups (bar raised)

Per the maintainer's "raise the bar every day" directive (2026-07-21), this pass
lands **two verified** improvements rather than only recording deferrals — the
vestigial `bestConnectionMethodAnthropic` duplication and the helper-model
precedence duplication. The
candidate the core reader mis-flagged as "dead, zero callers" (A1) is not dead —
but it _is_ genuine vestigial duplication, and it was collapsed with the full
gate suite green.

**What it was.** `bestConnectionMethodAnthropic`
(`src/agent/runtime/textConnection.ts`, formerly `:110-121`) was byte-for-byte
identical to `bestConnectionMethod` (`:94-105`) except the error-label string.
Its only importer — found by a **full-repo** grep (the core reader's "zero
callers" was the recurring `src/`-only-grep methodology error) — was
`packages/extension/src/commands/tests/connectionTests.ts`, whose
`handleTestConnection` diagnostic command ran the LaTeX connection test cases
through it under an "Anthropic" label alongside `bestConnectionMethod` under an
"OpenAI" label. Both functions route through the same
`bestConnectionMethodWithHelperModel`, so that OpenAI-vs-Anthropic comparison
ran identical logic twice — dead-weight from when the two paths genuinely
differed by provider.

**What was applied.** Deleted `bestConnectionMethodAnthropic`; collapsed
`handleTestConnection` to a single `runConnectionTests('helper model', …,
bestConnectionMethod)` run (dropped the duplicate import and the second,
identical run block). Net ~−22 LOC across the two files. No behavior change: the
command still exercises the one real connection method; nothing else referenced
the deleted symbol (grep-confirmed clean).

**Why this cleared the raised bar (crosses `packages/**`, so verified, not
swept).** Unlike the self-imposed "unattended-safe" bar of prior passes, this
edits a packaged command — so it was gated, not swept: `npm run typecheck`
exit 0 across **all six** project configs (root, test-kernel, extension, CLI,
trace-viewer, desktop); `eslint` clean on both touched files;
`TextConnectionHelperModel.vitest.ts` green (it exercises the retained
`bestConnectionMethod`, unaffected). The removed symbol had **no** dedicated
test. This is the same discipline the 07-18 pass used for the
`TextConnectionService` inline, applied one notch higher — a real
cross-package dedup, fully verified.

**Second cleanup applied — consolidate the helper-model precedence chain.**
`getHelperModelName` (`helperModelName.ts`) re-implemented the head of
`resolveEffectiveHelperModel`'s precedence chain inline (empty-config → default,
trim + is-default short-circuit) before delegating the tail, so the "validate
against candidates, else fall back" logic lived in two places despite the file's
own "single source of truth" docstring. Collapsed `getHelperModelName` to its
state reads + the one genuine runtime divergence (empty enabled-list = "no
restriction", accept a non-default configured model as-is, #7582) and deferred
everything else to `resolveEffectiveHelperModel`. Behavior-preserving: all 15
`helperModelName`/`helperModelPreference` tests pass (including the #7582
empty-candidate-list divergence guard), typecheck clean (six configs), eslint
clean.

**Candidates that did NOT survive verification (record — the audit's caller
counts were unreliable again).** Three further "easy" fan-out candidates were
examined and **rejected as keepers**, each an incomplete-grep artifact:
`inferAndLogPersistedModelHandlerCompatibilityKey` (flagged "single caller" — it
has **4** production callers across `executeAgent` / `SessionResumeRetrieval` /
`runToolUseFlow` / `runReflectionFlow` + a dedicated test); `emitRunFact`
(flagged inline-able — it has **15** callers and provides real name→payload
type-safety, not a pass-through); and `createChannelWriter`'s eager
`ensureChannel` (documented "ready-sink" intent — removing it changes when the
OutputChannel registers). The `support/AnthropicStreamHandler` relocation pulls
in a sibling `serverToolResultEmission` dependency — a genuine `support/`-boundary
decision, left reviewed-train. The `redaction.ts` trim was **withdrawn
entirely** on verification: both proposed cuts guard a security property (the
options path is a live desktop path-redaction caller; the provider map is a
`satisfies Record<ApiKeyProviderId>` exhaustiveness ratchet), so it is not a
cleanup target at all (see item 6).

**Go-forward posture (new this pass).** Each daily verification pass now aims to
land **at least one verified improvement**, not merely re-document reviewed-train
deferrals — draining the standing backlog one carefully-gated change at a time
rather than deferring the whole set indefinitely. The discipline is **verify
before landing** (the incomplete-grep rejections above are why): confirm caller
counts and test coverage in-tree, preserve behavior under the gate suite, and
only then land. "Reviewed-train" now means _verify before landing_, not _never
land unattended_.

## Genuinely-new / reviewed-train candidates — surfaced by this fan-out

Each is a signature/structure change, crosses `packages/**`, or deletes a
tested/used seam. **Reviewed-train, not unattended-safe** — record, don't sweep.
Several map onto already-tracked standing items (noted).

1. **`IModelHandler` port width is now ~41 members** _(strategic — the
   `query()`-alignment / message-opacity tension; not a defect)_. The model
   reader counted 40 `Pick`ed members (`IModelHandler.ts:43-82`) + 1 optional
   extension (`createBatchedToolUseFollowUpMessages`, `:100-108`) = **41** —
   higher than the **31** the 07-18 checkpoint recorded. Some of the delta is
   real growth (the `#9030` "snapshot model credential routes" work added
   credential-route members like `getLastCredentialUsageRoute` / `refreshClient`
   in the last few commits); the rest is likely a prior undercount — the exact
   07-18 tokenization isn't reproducible here. Either way the width is the same
   documented consequence of provider-opaque messages the north-star already
   records (~10 of the members are message-mutation methods the flow must
   round-trip through because `shared.messages` is untyped). A neutral internal
   transcript is the standing highest-leverage/highest-effort lever — do not
   flatten unattended. New concrete facets worth recording:
   (a) **two single-implementer methods leak into the shared contract** —
   `extractAssistantContent` (`IModelHandler.ts:77`) is overridden only by
   Anthropic (`modelHandlerAnthropic.ts`; base is a `[]` stub), and
   `extractServerToolData` (`:72`) only by Anthropic + OpenAIResponse — every
   other handler no-ops them; (b) **six provider-trait predicates**
   (`supportsManualCompaction`, `supportsForcedToolChoice`,
   `requiresPerCallSystemPrompt`, `isAutoRetryManagedByProvider`,
   `requiresBatchedParallelToolResults`, `isBackgroundModeActive`) are
   first-class port members. **Caveat (Codex review, P2 — corrects an earlier
   "fold into a `capabilities` object" suggestion):** these are **not** foldable
   into a static traits object. `ModelHandler.ts:653-687,720-784` records the
   #7101 triage explicitly — each stays an overridable getter/method because its
   value is computed per-handler at runtime, not read from a capability profile:
   `supportsManualCompaction` combines llm-zoo family eligibility with tool-use
   mode (Anthropic) or reads the ChatGPT-subscription profile with an OpenRouter
   fallback (OpenAIResponse); batching / per-call-system-prompt depend on
   concrete wire routing, not model capability; and OpenRouter's
   `isAutoRetryManagedByProvider(error)` branches on the actual error object.
   The narrow-surface observation stands (these do widen the port), but the fix
   is _not_ collapsing them into `capabilities` — keep them overridable. Facet
   of the same port-width item — reviewed, gated with the
   transcript-neutralization lever.

2. **`ModelHandlerGoogleGenAI` (1,136 LOC) + its GenAI-only
   `googleMessageHelpers` (66 LOC; **1,202 LOC together**, recounted at
   `3612630`) is the single largest available
   simplification** _(strategic; gated on the flag retirement, #7097)_.
   Unchanged in substance from the README's standing note: `modelHandlerGoogleGenAI`
   is a **feature-frozen** fallback that **new** sessions instantiate only when
   `texra.model.useGoogleInteractionsAPI` is explicitly off (default is `true`,
   `ModelFactory.ts:232`; OpenRouter also wins ahead of it), so no new run under
   the default constructs it. Its GenAI-only helper module
   (`googleMessageHelpers.ts`) is imported only by that handler + its test — not
   shared despite living in the shared `google/` folder. **Caveat (Codex review,
   P2 — corrects an earlier "default-unreachable" overstatement):** the handler
   is **not** unreachable under the default. The resume path
   `createModelHandlerForCompatibilityKey` (`ModelFactory.ts:454-474`)
   explicitly reconstructs a handler from a persisted transcript's
   `ModelHandlerCompatibilityKey` so the recorded format wins over today's
   default route — and `ModelHandlerGoogleGenAI` is a valid persisted key
   (`inferPersistedModelHandlerCompatibilityKey` can return it). So any existing
   GenAI-format session still resumes into this handler regardless of the flag.
   Removing it is therefore **not** a pure "flag retires → delete" win: it must
   be gated behind a persisted-transcript migration or an explicit
   compatibility-key-retirement policy, or existing GenAI sessions lose the
   ability to resume. Still the biggest LOC win in the provider layer, but the
   gate is transcript-format retirement, not just the config flag. Gated on
   #7097 + resume-format retirement, not unattended-safe (deletes a handler +
   its tests).

3. **`ModelHandler.ts` is a ~1,931-line base class tangling ~7 concerns**
   _(MEDIUM; strategic — the standing `runTurn`/`streamTurn`-façade train)_.
   Grew from ~1,863 (07-18) to 1,931 LOC — modest, tracks the credential-route
   work. The heavy machinery is **already** delegated to `support/`
   collaborators, the base imports **zero** provider-specific modules, and the
   16 abstract methods every provider implements justify the abstraction. Do
   not collapse it; further decomposition of the remaining orchestration is the
   standing reviewed-train item, not new debt. (The 07-18 candidates —
   `OpenRouterNative` re-implementing the OpenAI chat shape, the six
   OpenAI-compatible subclasses staying classes because MiniMax/Kimi/DeepSeek
   carry real divergent wire logic while DashScope/XAI/GLM are consolidatable —
   were independently re-derived and are unchanged.)

4. **The extension host does not share `createNodePlatform`** _(MEDIUM;
   reviewed-train — new concrete finding)_. CLI and desktop both compose the
   platform through `createNodePlatform` + the shared 5-helper post-init
   sequence in `src/platform/defaults/nodeHost.ts` (a module that exists
   precisely to prevent CLI/desktop drift). `packages/extension/src/extension.ts`
   instead **hand-inlines** the entire `initPlatform({...})` object and a
   parallel copy of the memory/goal/skill/prompt registration
   (`extension.ts:213-286`). The inlining is **deliberate** — a documented
   bundle-size tradeoff (avoid pulling the skill module's Lean direct-adapter
   import into the extension bundle) — but it leaves the composition sequence in
   two hand-synced places. This is the host-facing half of the north-star's
   NS-1 "bootstrap incantation" (two-phase init: `initPlatform()` plus an
   untyped post-init registration sequence not captured in the `Platform`
   object) — confirmed still present on all three hosts. Reviewed-train.

5. **`HostInteractions` is still 0/N required except `cancel`** _(TD-2 contract
   residue; tracked)_. The host reader re-confirmed the north-star TD-2 item:
   `HostInteractions` has 15 members, only `cancel` mandatory
   (`HostInteractions.ts:341`); the other 14 are `?`-optional. **Return-shape
   correction (Codex review, P2):** they do not uniformly return
   `Promise|undefined` — only the **seven request methods**
   (`requestToolEditApproval` / `requestBashApproval` / `requestPlanApproval` /
   `requestAgentProposal` / `requestRetry` / `askUserQuestion` /
   `openExternalInquiry`) return `Promise<…> | undefined`; `emit`,
   `setApprovalBypassState`, and `dispose` return `void`, `showInfoMessage`
   returns `Promise<void> | void`, and `readDiagnostics` / `addCriticism` /
   `notifyUnavailableTools` are callback-property members. The differing shapes
   matter for the Step-1 conversion: it is specifically the runtime-hard-required
   approval **request** methods (the `Promise|undefined` group) that should
   become required. **Count correction (Codex review, P2):** that group is **7,
   not 6** — `openExternalInquiry` is also runtime-hard-required, not optional in
   practice: selecting the registered external-inquiry tool reaches
   `ExternalInquiryTool.ts` (`~:473-476`), which does
   `ownerSession.interactions.openExternalInquiry(permission)` and **throws**
   `'HostInteractions.openExternalInquiry is required'` if it's absent. All three
   UI hosts and the headless CLI adapter already implement it. So the north-star
   TD-2 "convert 6/7 to required" target should be **7/7** of the request methods
   — leaving `openExternalInquiry` optional preserves a contract that crashes the
   inquiry tool path. (Target still gated on #6968 Sweep 1.) The headless CLI
   adapter (`packages/cli/src/runtime/approvalAdapter.ts`) proves the minimal
   headless surface is `cancel` + the policy-unsatisfiable subset of those
   request methods; everything in the 5 presentation events is ignorable by
   contract.

6. **`logger/redaction.ts` — withdrawn as a cleanup candidate; keep the whole
   module** _(the "new finding" did not survive verification — two P2 catches)_.
   The original finding claimed two trims (flatten the 14-entry provider map;
   drop the "dead" options path). **Both are wrong, and each guards a security
   property:**
   - **The options path is load-bearing (Codex review, P2 — an earlier draft
     wrongly called it "dead-in-prod").** The `LogRedactionOptions` / `homeDir` /
     `workspacePath` path-prefix redaction has a live production caller:
     `packages/desktop/src/main/desktopAppLog.ts:63-81` (`readDesktopLogSnapshot`)
     builds the options via `makeDesktopLogRedactionOptions(...)` and passes them
     to `redactSecrets(path, opts)` / `redactSecrets(text, opts)` for the desktop
     log-viewer snapshot (path, contents, read-error text). Trimming it would
     stop replacing home/workspace prefixes — **leaking users' local paths** in
     the log viewer and copied diagnostics. (Same `src/`-only-grep error — the
     logger reader missed the `packages/desktop` caller.)
   - **The provider map is an exhaustiveness ratchet, not test-only granularity
     (Codex review, P2).** `PROVIDER_KEY_REDACTION_RULES` (`redaction.ts:28-71`)
     is declared `as const satisfies Record<ApiKeyProviderId, ProviderKeyRedactionRule>`
     (`:71`), where `ApiKeyProviderId` derives from `API_KEY_PROVIDER_IDS`
     (`@shared/constants/providers`, `:16`). That `satisfies` makes a **missing
     provider a compile-time type error** — a security ratchet forcing every
     direct-key provider to carry a redaction rule. Flattening to a bare
     4-regex list would delete the ratchet, so a future direct-key provider
     could reach logs **unredacted**. Keep the exhaustive map.

   Net: `redaction.ts` is **not** a cleanup target — the runtime dedupe to ~4
   regexes is an implementation detail behind a deliberate type-level guarantee,
   and the redaction **core** (JSON-property / assignment / Bearer passes) is
   single-purpose and correct. Keep all of it. (Record: this is a candidate the
   fan-out surfaced that fully dissolved under verification.)

7. **`AgentFlowResult` → `AgentFinalResult` result construction**
   _(resolved)_. The retired persisted-result decoder and its third result
   builder were removed; storage now accepts only the canonical result schema.
   The live flow-to-final projection remains the single lifecycle boundary.
   _(The two sibling candidates an earlier draft listed here —
   `inferAndLogPersistedModelHandlerCompatibilityKey` and the helper-model
   precedence duplication — have been resolved elsewhere in this doc and are
   **not** open reviewed-train work: the former is a 4-caller tested helper kept
   as-is (see "Candidates that did NOT survive verification"), and the latter
   was consolidated this pass (see "Applied this pass"). Do not re-flag either.)

## Reviewed-train / strategic + adjudicated traps — held

No change from 07-18. The fan-out re-derived the standing set; rulings hold: the
`ResponseCycleNode`/`ToolUseCycleNode` `exec()→run inner flow→interpret` wrapper
(**keep** — the outer node owns real per-round orchestration; "collapse the
inner node graph to a turn-loop" is the _strategic_ largest-single-structure
item, gated); `IModelHandler` as a "duplicate" of `ModelHandler` (**trap** —
removal breaks a real import cycle); folding the single-caller
`createResponseCycleFlow` / `createToolUseRoundFlow` into their nodes (**keep** —
this _is_ the prescribed `Node.exec() → createFlow() → run()` shape);
`runAgent`/`executeAgent` dual entry (**keep** — two documented
responsibilities); collapsing the OpenAI-compatible subclasses to a config table
(**trap** — real per-provider overrides + enum-mandated route table);
`IToolUseSession` single-impl port (**keep** — host-agnosticism seam);
`ModelInvocationNode` (**keep** — genuinely shared by both cycle flows via
config); `withModelClient` (**keep** — load-bearing live-`client` getter for
relay-401 rebinding). The re-surfaced 07-18 false positives were **not**
re-derived as removable this pass — but for the record they remain held:
`followUpResumeDetection` (extension caller + dedicated vitest),
`IToolRegistry` (single-impl port on the `core/flows`→tools edge),
`RetryableInvocationNode` (test subclass drives the base). The `Shared*`
singletons → session ownership, the helper-model / content-helper cluster
relocation, the four VS-Code-only `Platform` diagnostic ports, the
`SdkToolCall` → generic `NormalizedToolCall`, packaging / barrels, and the
minimal-embedder `Platform` all remain **strategic/gated** exactly as the
north-star sequences them.

## Observability — the unified-stream item re-confirmed (strategic)

The logger reader independently re-derived the standing "three payload
vocabularies" observation and sharpened it: `AgentTrace`/`TraceEmitter`
(`agent/trace/`, the 20-arm `AgentEvent` union at `events.ts:346-366`) is
**already the Agent-SDK-style single stream**; `SessionEventHub`'s `run` scope
is a **verbatim re-broadcast** of each run's `TraceEmitter`
(`SessionHandle.publishRunEvent`), union'd with the session-only `SessionFact`
vocabulary; and `runtimeInteractionEvents` / `runtimePresentationEvents` are two
parallel host-routing name-registries over the same "things that happen."
**Correction (Codex review, P2):** `runFactEvents` is **not** a third such
registry — `runFactEvents.ts:28-33`'s `emitRunFact` is a type-safe helper that
emits run facts (`updateTodos`, `updatePlan`, …) **directly into `AgentTrace`**,
and those facts are already arms of `AgentEvent`; it is not a separate delivery
surface, so counting it here overstates the duplication (and folding the event
stream must **not** delete that type-safe helper — it reduces no channel). The
genuine parallel registries are the interaction/presentation two.
`eventBus/AppSignals` is **correctly separate** (process-lifecycle, out of
band). A unified design folds `SessionFact` into
`AgentEvent` as session-scoped arms and replaces the hub's re-broadcast with a
session-level multiplexer — collapsing four surfaces to one stream +
`AppSignals`. **Design constraint (Codex review, P2 — corrects an earlier
"subscribers self-filter" phrasing):** keep the **filtering broker-side in the
multiplexer**, not on the subscriber callback. `SessionEventHub.emit`
(`SessionEventHub.ts:94-121`) deliberately applies scope / stream / type filters
**before** invoking each callback ("so high-volume stream chunks only reach
consumers that explicitly asked for them"); moving that to callback-side
self-filtering would hand every subscriber (progress view, CLI, snapshot store,
…) every `stream.chunk` to discard, regressing streaming overhead. The
consolidation unifies the vocabularies; it must **preserve** the broker-side
pre-dispatch filter. This is the standing strategic item; the
logger dual front door (functional `debug/info` + the
`createChannelTrace`-as-module-logger idiom, **39** importers now, up from 36)
is tracked in `2026-05-17-logger-simplification-feasibility.md`. `logUtils.ts` /
`redaction.ts` themselves stay a thin, justified sink wrapper — keep. Note:
there is **no `platform().log` port** — logging is deliberately its own
subsystem (`platform.ts:31-34`, wired via `logUtils.setOutputChannelFactory`),
so the log path already carries zero platform-port indirection.

## Minimal public surface for an external SDK consumer — re-confirmed

The runtime reader re-derived the same ~six-symbol irreducible set to start a
run and observe events (writable `StreamLogStore`, `initializeDefaultSession` /
`SessionHandle`, `validateExecutionRequest`, `runAgent`,
`noopAgentRuntimeHost`, `session.events.subscribe` / `session.onResult`) and the
same conceptual ~5-function run/resume entry surface (`runAgent`,
`executeAgent`, `resumeToolUseFromResumeData`,
`resumeQueuedToolUseFromResumeData`, `resolveAndResumeStream`). The residual
friction is exactly the north-star's NS-1/NS-3: the two-phase init and the
per-run ceremony, shrunk by **deleting** host bookkeeping into `SessionHandle`,
**not** by adding a `runSession()` wrapper (readiness doc Step-6 rejection —
held).

## Subagent split points — re-confirmed, gating observation unchanged

Delegation remains a **mature strategy-pattern subsystem**, not something to
build: `childRunLoop.ts` `startChildRunLoop` (one generic driver over every
child-run type via the `ChildRunStrategy<TTurn>` interface) + the
`src/tools/delegation/` strategies + `executionRegistry` lineage
(`parentStreamId`, `registerChildRunLoop`, `getActiveChildren`,
`interruptActiveChildren`, `detachActiveChildren`) + `detachSubagentsOnStop`
(single detach-vs-cascade policy) are already the SDK spawn shape. The
helper-model one-shots (`generateSessionDescription`, `polishTextWithAI`,
`bestConnectionMethod`) are the cleanest already-present SDK-aligned unit — one
prompt, no loop, no tools, all through the shared `createHelperModelKit` /
`runHelperModelCompletion` path. Ranked split points unchanged from `-06-26` →
`-07-18`:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation.
2. Introduce a typed `delegateTo(subagent, input, {maxDepth, tools})` over
   `childRunLoop` + `ChildRunStrategy` + `executeAgent`.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents into draft → Verifier →
   apply hand-offs — gated by #4.

**Gating observation (corrected this pass — Codex review, P2):** prior
checkpoints said "delegation depth is tracked but never gated." That overstates
what exists. What the runtime tracks is **immediate parent lineage**
(`parentStreamId` / `parentExecutionId`), **not depth** — the persisted
`delegationDepth` field was retired and is now explicitly discarded on load
(`ExecutionKVStore.vitest.ts:109` "legacy-delegation-depth" fixture;
`traceViewerSchema.vitest.ts:148` asserts `.not.toHaveProperty('delegationDepth')`).
There is likewise no `maxDelegationDepth` runtime setting (grep: **0 hits**
across `src/` and `packages/`). So a real depth cap is a **two-part**
prerequisite before exposing recursive `delegateTo(...)` as a public SDK surface
(split point #2): first **derive or reintroduce a depth counter** from the
lineage chain, then gate a maximum on it. It is not merely "add enforcement to
an already-tracked depth."

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is
healthy and the spine anchors hold at `3612630` (v0.39.8). The notable delta
this pass is a **completed** north-star action, not new debt: **Step 0's R-a
(inbound host-import freeze in eslint) and R-b (frozen per-host deep-import
baseline + enforcement script) are both installed and enforcing** — the
boundary the north-star flagged as "eroding while unfenced" is now fenced at a
zero-violation baseline, and host deep-import width dropped on all three hosts
this window (extension 44→41, CLI 34→31, desktop 29→26). **Two verified
improvements were applied** under the "raise the bar every day" directive: the
vestigial `bestConnectionMethodAnthropic` duplication (~−22 LOC) and the
helper-model precedence duplication (`getHelperModelName` now defers its whole
validate-else-fall-back chain to `resolveEffectiveHelperModel`) — both gated
green across all six typecheck configs + lint + their tests, real dedups, not
blind sweeps. Three further "easy" candidates were verified and **kept**
(`inferAndLog…` 4 callers + test, `emitRunFact` 15 callers + type-safety,
`createChannelWriter` eager sink documented) — the audit's caller counts were
the recurring incomplete-grep error. The `redaction.ts` "finding" also fully
dissolved under verification — both its proposed trims guard a security property
(the options path is a live desktop path-redaction caller; the provider map is a
`satisfies Record<ApiKeyProviderId>` exhaustiveness ratchet), so it is **not** a
cleanup target. Every remaining item is reviewed-train (`ModelHandler`
decomposition, the `IModelHandler` port-width facets — kept as overridable per
the #7101 triage, not folded into `capabilities` — the extension composition
duplication, the `AgentFinalResult` two-schema rename) or strategic/gated (the
frozen `GoogleGenAI` handler gated on **#7097 _plus_ persisted-transcript /
compatibility-key retirement** so existing GenAI sessions still resume, message
opacity → neutral transcript, the unified event stream — preserving broker-side
filtering — the `HostInteractions` **7/7** required-methods conversion behind
Step 1). Do not re-open the traps; do not re-flag `followUpResumeDetection`,
`IToolRegistry`, or `RetryableInvocationNode` as dead (each has a live caller or
a test seam a `src/`-only grep misses); verify reviewed-train items before
landing rather than sweeping them unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `3612630`: `createModelHandler` +
  `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts:426`,`:72`), `IModelHandler` =
  `Pick<ModelHandler>` (`src/agent/types/IModelHandler.ts:41`),
  `src/agent/core/index.ts` **absent** (no barrel regression),
  `emitRuntimeEvent` **retired** (sole grep hit is
  `sessionFactAmbientHelperRetirement.vitest.ts`), `RunScope.ts:14-19` carries
  `readonly` `streamId`/`executionId`/`agentName`, `Node.exec → createFlow().run`
  intact (`ResponseCycleNode.ts:104`; `ToolUseCycleNode.ts:101`).
- **Step 0 ratchets verified live:** R-a in `eslint.config.mjs`
  (`HOST_LAYER_RESTRICTED_IMPORT_PATTERNS` forbids `src/**` → `@cli/**` /
  `@desktop/**` / 9 extension-homed aliases; plus
  `AGENT_CORE_RESTRICTED_IMPORT_PATTERNS`); R-b as
  `config/ratchets/host-agent-import-baseline.json`, enforced by the Vitest suite
  `src/test-kernel/architecture/hostAgentDeepImportRatchet.vitest.ts` (which reads
  the baseline and fails on any host exceeding its pinned count) — **not**
  `packages/cli/scripts/check-host-imports.mjs`, which is a separate
  vscode/electron + `process.*` boundary checker that does not read the width
  baseline; `#9027` "preserve host import ratchet" confirms active enforcement.
- Boundary metric recounted at `3612630`: distinct `@agent/*` deep-import
  specifiers — extension **41**, CLI **31**, desktop **26** (07-18: 44/34/29;
  north-star baseline 49/35/27). Core→host alias violations: **0**.
- Applied cleanup verified: `bestConnectionMethodAnthropic` (was
  `textConnection.ts:110`, byte-identical to `bestConnectionMethod`) deleted and
  its sole caller `handleTestConnection`
  (`packages/extension/src/commands/tests/connectionTests.ts`) collapsed to a
  single run; ~−22 LOC. `npm run typecheck` exit 0 (all six configs), `eslint`
  clean on both files, `TextConnectionHelperModel.vitest.ts` green. The core
  reader's "zero callers" was the recurring `src/`-only-grep error — the live
  caller was in `packages/extension`.
- Port width re-measured: `IModelHandler` = 40 `Pick`ed + 1 optional = **41**
  members (07-18 recorded 31); `ModelHandler.ts` **1,931** LOC (07-18 ~1,863),
  16 abstract methods; `AgentEvent` union **20** arms (unchanged).
- `ModelHandlerGoogleGenAI` confirmed not instantiated by **new** runs under
  the default (`useGoogleInteractionsAPI` default `true`, `ModelFactory.ts:232`),
  but **still reachable on resume** via `createModelHandlerForCompatibilityKey`
  (`ModelFactory.ts:454-474`) when a persisted transcript carries its
  compatibility key — so removal is gated on transcript-format retirement, not
  just the flag; its `googleMessageHelpers` imported only by that handler + test.
- `createNodePlatform` confirmed used by CLI + desktop, **not** by
  `packages/extension/src/extension.ts` (hand-inlined composition — deliberate
  bundle tradeoff).
- Logger census: `createChannelTrace` importers **39** (07-18: 36). No
  `platform().log` port (`platform.ts:31-34`).
- Delegation: parent **lineage** tracked (`parentStreamId`/`parentExecutionId`),
  but **depth is not** — the persisted `delegationDepth` field was retired and is
  discarded on load (`ExecutionKVStore.vitest.ts:109`;
  `traceViewerSchema.vitest.ts:148`), and there is no `maxDelegationDepth` (0
  grep hits across `src/` + `packages/`). A depth cap must first derive/reintroduce
  depth, then gate it.
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
