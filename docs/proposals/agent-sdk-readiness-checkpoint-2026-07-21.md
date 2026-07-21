# Agent SDK Readiness — Verification Checkpoint (2026-07-21)

**Status:** Verification checkpoint. Read alongside the canonical
[`agent-sdk-readiness.md`](./agent-sdk-readiness.md), the plan of record
[`agent-sdk-north-star.md`](./agent-sdk-north-star.md), the detailed
[`../agent-sdk-readiness-audit.md`](../agent-sdk-readiness-audit.md), the
[`agent-sdk-readiness-delta-2026-06-24.md`](./agent-sdk-readiness-delta-2026-06-24.md)
addendum, and the `-2026-06-25` → `-2026-07-18` checkpoints (most recently
[`-2026-07-18`](./agent-sdk-readiness-checkpoint-2026-07-18.md)).

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
  `config/ratchets/host-agent-import-baseline.json` + the enforcement script
  `packages/cli/scripts/check-host-imports.mjs`, wired as the CLI package's
  `check:architecture` script. The baseline's own doc string states the R-b
  contract verbatim ("The ratchet fails only when a host's distinct-specifier
  count exceeds this baseline; a decrease … is welcome and should shrink this
  file"), citing issue #7684 R-b. Two companion baselines
  (`architecture-edges-baseline.json`, `host-agent-mock-baseline.json`) guard
  adjacent edges. The `#9027` commit ("fix(desktop): preserve host import
  ratchet") shows the ratchet is actively catching regressions.

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

## Applied this pass — collapse the vestigial `bestConnectionMethodAnthropic` duplication

Per the maintainer's "raise the bar every day" directive (2026-07-21), this pass
lands one **verified** improvement rather than only recording deferrals. The
candidate the core reader mis-flagged as "dead, zero callers" (A1) is not dead —
but it *is* genuine vestigial duplication, and it was collapsed with the full
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

**Go-forward posture (new this pass).** Each daily verification pass now aims to
land **at least one verified improvement**, not merely re-document reviewed-train
deferrals — draining the standing backlog one carefully-gated change at a time
rather than deferring the whole set indefinitely. The reviewed-train items below
remain the queue; "reviewed-train" now means *verify before landing*, not *never
land unattended*.

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
   other handler no-ops them; (b) **six provider-trait booleans**
   (`supportsManualCompaction`, `supportsForcedToolChoice`,
   `requiresPerCallSystemPrompt`, `isAutoRetryManagedByProvider`,
   `requiresBatchedParallelToolResults`, `isBackgroundModeActive`) are
   first-class port members that a traits object (`capabilities` already
   exists) would fold. Both are facets of the same port-width item — reviewed,
   gated with the transcript-neutralization lever.

2. **`ModelHandlerGoogleGenAI` (~1,136 LOC) + its GenAI-only
   `googleMessageHelpers` (~1,350 LOC together) is the single largest available
   simplification** _(strategic; gated on the flag retirement, #7097)_.
   Unchanged in substance from the README's standing note: `modelHandlerGoogleGenAI`
   is a **feature-frozen** fallback reachable only when
   `texra.model.useGoogleInteractionsAPI` is explicitly off (default is `true`,
   `ModelFactory.ts:232`; OpenRouter also wins ahead of it), so in the default
   configuration it is never instantiated. Its GenAI-only helper module
   (`googleMessageHelpers.ts`) is imported only by that handler + its test — not
   shared despite living in the shared `google/` folder. Removing both once the
   flag retires is the biggest LOC win in the provider layer. Gated on #7097,
   not unattended-safe (deletes a handler + its tests).

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
   (`HostInteractions.ts:341`); the other 14 are `?`-optional with
   `Promise|undefined` returns while ~6 approval gates are runtime-hard-required
   in practice. The north-star Step-1 target (convert 6/7 to required, riding
   A2's legacy-fallback deletion) is unmet — expected, Step 1 is gated on #6968
   Sweep 1. The headless CLI adapter
   (`packages/cli/src/runtime/approvalAdapter.ts`) proves the minimal headless
   surface is `cancel` + the policy-unsatisfiable subset of the 6 approval
   gates; everything in the 5 presentation events is ignorable by contract.

6. **`logger/redaction.ts` is partly over-structured / dead-in-prod**
   _(LOW; reviewed-train — new concrete finding)_. The 14-entry
   `PROVIDER_KEY_REDACTION_RULES` (`redaction.ts:28-71`) dedupes to ~4 distinct
   regexes at `PROVIDER_KEY_PATTERNS` (`:73-81`) — the per-provider granularity
   feeds mostly its own test. The `LogRedactionOptions` / `homeDir` /
   `workspacePath` path-prefix redaction path (`:83-116`) has **no production
   caller** — `logUtils.ts:77` always calls `redactSecrets(message)` with no
   options; only `DesktopLogRedaction.vitest.mts` exercises the options path.
   Trimming it deletes a **tested** seam and edits provider fixtures →
   reviewed-train, not unattended-safe. The redaction **core** (JSON-property /
   assignment / Bearer passes + 4 provider regexes) is single-purpose and
   correct — keep.

7. **`AgentFlowResult` → `AgentFinalResult` two-schema rename + a third builder**
   _(LOW; reviewed-train — record only)_. `buildAgentFinalResult`
   (`AgentFinalResult.ts:133-166`) `.pick()`s the flow schema and renames
   `lastResponse→response` / `touchedFiles→files`, and
   `storage/resultMeta.ts:235` `buildLegacyAgentFinalResult` is a third
   constructor of the same shape. One logical result is defined/rebuilt in three
   places; the rename layer is avoidable churn **if** the flow result had used
   the canonical names, collapsible when the legacy persisted shape can be
   dropped. Crosses `storage/` + a schema change with tests → reviewed-train.
   (The shared projection helper `projectToolUseFinalTextFields` is legitimately
   2-caller — keep.) Minor sibling notes: `inferAndLogPersistedModelHandlerCompatibilityKey`
   (single-caller log wrapper, one caller `executeAgent.ts:505`) and the
   duplicated helper-model precedence between `getHelperModelName` /
   `resolveEffectiveHelperModel` in `helperModelName.ts` — both borderline,
   both in the resume/helper path, reviewed-train.

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
vocabulary; and `runFactEvents` / `runtimeInteractionEvents` /
`runtimePresentationEvents` are three parallel host-routing name-registries over
the same "things that happen." `eventBus/AppSignals` is **correctly separate**
(process-lifecycle, out of band). A unified design folds `SessionFact` into
`AgentEvent` as session-scoped arms and replaces the hub's re-broadcast with a
session-level multiplexer whose subscribers self-filter — collapsing four
surfaces to one stream + `AppSignals`. This is the standing strategic item; the
logger dual front door (functional `debug/info` + the
`createChannelTrace`-as-module-logger idiom, **39** importers now, up from 36)
is tracked in `logger-simplification-feasibility.md`. `logUtils.ts` /
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

**Gating observation (unchanged, re-verified):** delegation depth is tracked but
never gated — there is still no `maxDelegationDepth` runtime setting (grep: **0
hits** across `src/` and `packages/`). A real depth cap remains a prerequisite
before exposing recursive `delegateTo(...)` as a public SDK surface (split
point #2).

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is
healthy and the spine anchors hold at `3612630` (v0.39.8). The notable delta
this pass is a **completed** north-star action, not new debt: **Step 0's R-a
(inbound host-import freeze in eslint) and R-b (frozen per-host deep-import
baseline + enforcement script) are both installed and enforcing** — the
boundary the north-star flagged as "eroding while unfenced" is now fenced at a
zero-violation baseline, and host deep-import width dropped on all three hosts
this window (extension 44→41, CLI 34→31, desktop 29→26). **One verified
improvement was applied** under the "raise the bar every day" directive: the
vestigial `bestConnectionMethodAnthropic` duplication was collapsed (~−22 LOC,
gated green across all six typecheck configs + lint + the retained test) — a
real cross-package dedup, not a blind sweep. The core reader's "dead, zero
callers" flag on it was the recurring `src/`-only-grep error (it had a live
extension caller); the symbol was genuinely redundant, not genuinely dead.
Every remaining item is reviewed-train
(`ModelHandler` decomposition, the `IModelHandler` port-width facets, the
extension composition duplication, the `redaction.ts` provider-map/options
trim, the `AgentFinalResult` two-schema rename) or strategic/gated (the frozen
`GoogleGenAI` handler behind #7097, message opacity → neutral transcript, the
unified event stream, the `HostInteractions` required-methods conversion behind
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
  `config/ratchets/host-agent-import-baseline.json` +
  `packages/cli/scripts/check-host-imports.mjs` (wired as CLI `check:architecture`);
  `#9027` "preserve host import ratchet" confirms active enforcement.
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
- `ModelHandlerGoogleGenAI` confirmed default-unreachable
  (`useGoogleInteractionsAPI` default `true`, `ModelFactory.ts:232`); its
  `googleMessageHelpers` imported only by that handler + test.
- `createNodePlatform` confirmed used by CLI + desktop, **not** by
  `packages/extension/src/extension.ts` (hand-inlined composition — deliberate
  bundle tradeoff).
- Logger census: `createChannelTrace` importers **39** (07-18: 36). No
  `platform().log` port (`platform.ts:31-34`).
- Delegation depth verified still tracked-but-ungated (no `maxDelegationDepth`,
  0 grep hits across `src/` + `packages/`).
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
