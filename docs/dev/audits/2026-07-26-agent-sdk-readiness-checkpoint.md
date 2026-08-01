# Agent SDK Readiness — Verification Checkpoint (2026-07-26)

**Status:** Verification checkpoint. Read alongside the current audit of record
[`../dev/audits/2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md)
(the post-retirement snapshot), the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the plan of
record [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md), the
trace-surface companion [`2026-05-22-agent-trace-sdk-surface.md`](../../proposals/2026-05-22-agent-trace-sdk-surface.md),
and the `-2026-06-25` → `-2026-07-23` checkpoint chain (most recently
[`-2026-07-23`](./2026-07-23-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against branch
`claude/eager-noether-10hqsl` at HEAD `5fc03f9` (`CHANGELOG.md` heading
`[0.39.9] - Unreleased`). The `-07-23` pin `f7dded0` **is** an ancestor of that
HEAD: `git merge-base --is-ancestor f7dded0 5fc03f9` succeeds, and
`git rev-list --count f7dded0..5fc03f9` reports **105 commits**. This pass did
not perform a commit-by-commit audit of that range. It instead inspected the
tree afresh at `5fc03f9` and reconciled its findings against the `-07-25` audit,
the freshest same-scope record. The statements below are therefore
current-tree findings, not a claim that each of the 105 intervening commits was
individually reviewed.

**Run context (honesty note).** This was an **unattended scheduled run** with
**no external adversarial review available** (no Codex second pass — the lever
the `-07-22` checkpoint relied on to catch its own applied-then-reverted
mistake). It ran a **fresh, uninformed four-way fan-out audit** — four
independent readers briefed only with the repo's anti-abstraction rules and
_not_ with the standing adjudications. The readers audited:

1. `agent/core`, `agent/runtime`, and `agent/implementations/flows`;
2. `agent/modelHandlers`, `toolConversion`, `IModelHandler`, and
   `ModelFactory`;
3. `logger`, the public API and export surface, and the host→core import
   boundary;
4. the delegation and subagent subsystem, together with possible split points.

Findings were then reconciled against the `-07-25` audit and the adjudicated
rulings in the standing checkpoints. This pass deliberately **applies no code
change** — see "No change lands" below.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** Four fresh, uninformed readers independently
re-reached the standing conclusion — the same reconvergence every pass since
`-06-26` has recorded, and the same headline the `-07-25` audit states ("already
unusually well-aligned and _not_ over-abstracted"). **Every substantive
candidate the fan-out surfaced maps onto an already-adjudicated trap (ruling
held), an already-tracked strategic item, or a finding already recorded in the
`-07-25` audit.** The fan-out surfaced **zero genuinely-new actionable debt.**
Two items are worth recording as _refinements_ to the standing record (a stale
cross-reference in the `-07-15` audit, and a not-previously-named provider-port
coupling); neither is actionable in an unattended pass.

## Fan-out findings mapped to the standing record — all held or non-actionable

### Reader 1 — agent core (`core` / `runtime` / `flows`)

1. **[Keep] No removable pass-through wrappers.** Independently confirmed the
   CLAUDE.md anti-abstraction pattern is actually followed:
   `ResponseCycleNode.exec()` creates and runs `createResponseCycleFlow<C>()`
   inline (`reflection/nodes/ResponseCycleNode.ts:105`), no wrapper between node
   and flow. `runAgent` vs `executeAgent` remains justified by execution-ID
   ownership, but the direct production caller census is **three**, not 20+:
   `runAgent.ts`, `nativeSubagentStrategy.ts`, and the lazy import in
   `inBandSubagentExecution.ts`. The `AgentFlowResult` →
   `AgentRuntimeFlowResult` (WAITING arm) → `AgentFinalResult` (post-artifact
   envelope) chain, the `helperModel` / `helperModelName` /
   `helperModelPreference` split, and the single-implementation
   `IToolUseSession` port were each examined and **excluded as justified**.
   Matches `-07-25` §3 and the held rulings carried since `-07-18`/`-07-21`.

2. **[Keep] `createRunScope`** (`RunScope.ts:26`, 1 caller,
   `AgentLaunchContext.ts:385`) — a freeze-only factory. The reader's own verdict
   is "stylistic, not dead weight": the `Object.freeze` is a real (tiny)
   immutability invariant. Recorded, not applied — its net gain is ~1 LOC and it
   is exactly the class of near-zero-value single-caller nit the `-07-23`
   checkpoint declined to land unattended (item ⑧ precedent).

3. **[strategic] The real core/runtime item is the intra-`agent` dependency
   cycle, not excess layers.** `core/flows` reads ambient `RunContext`
   (AsyncLocalStorage) and `runtime/textConnection`; `runtime` imports
   `implementations/flows` and `@tools`. This is **`-07-25` §1 verbatim** (the
   "#1 SDK-extraction obstacle") and the north-star's NS-1, gated behind a real
   package cut. Not cleanup.

### Reader 2 — model handlers

4. **[Keep] `ModelHandler.ts` (~2,061 LOC) is a real shared base, not a
   god-object; `ModelFactory` is a justified factory.** Confirmed genuine
   per-provider overrides rather than single-override template ceremony; the
   `#7101`-triage reviewed-train ruling holds (do not collapse the justification
   doc-comments). Matches `-07-23` item 4.

5. **[strategic] `IModelHandler`'s 44-member surface fuses a provider-adapter
   contract with TeXRA runtime-coordination methods.** The surface comprises 43
   members selected by `Pick<ModelHandler>` and one optional intersection
   member, `createBatchedToolUseFollowUpMessages`. Coordination examples include
   `getWireRouteKey`, `getModelRetryRouteKey`, `getCredentialRouteForClient`,
   `requestCompaction`/`clearCompactionRequest`, and
   `consumeInsertedAttachmentKinds`.
   This is the standing **port-width / message-opacity** strategic item
   (`-07-23` item 5): auto-derived via `Pick<ModelHandler>` so it is a
   surface-shape observation, not a drift risk or a delete. A real SDK port would
   separate the ~10–12-member invocation contract from the coordination helpers.
   Gated, not applied. Re-confirmed `IModelHandler = Pick<ModelHandler>` at
   `src/agent/types/IModelHandler.ts:41`.

6. **[strategic] `SdkToolCall` embeds every vendor SDK's raw types**
   (`ModelHandlerContracts.ts:11-18`: `openai/resources/…`, `@google/genai`,
   `@anthropic-ai/sdk`, `@openrouter/sdk`) and is the port's default `T`, so the
   would-be-public port transitively names all four vendor SDKs. **Already
   tracked** — the identifier and this tension appear in the `-07-15` audit and
   the `-07-10`/`-07-12`/`-07-18`/`-07-21` checkpoints and
   `2025-11-27-openai-sdk-type-improvements.md`. Part of the same port-shape
   strategic item; keep `T` generic at the port when the boundary is drawn. No
   new action.

7. **[refinement, new framing] Provider port does workspace filesystem I/O.**
   `initializeOutputAndPrefill` (`ModelHandler.ts:1494-1566`) calls
   `FlexibleFS.write` / `AbsoluteFS.ensureDir` (import at `:87`) and mutates
   `workspaceState.assembly` — a provider adapter reaching into TeXRA's
   output-file model. This coupling is real and host-agnostic (no `vscode`), but
   it is not named as an SDK-boundary finding in the standing checkpoints (it
   surfaces only as implementation detail in the Google-Interactions and
   `-07-03` tech-debt docs). Recorded here as a **candidate strategic item**: if
   the provider port is ever split (item 5), output-file/prefill lifecycle should
   move up into the flow/workspace layer rather than ride on the adapter. **Not
   applied** — it is a spine method behind the port and exactly the kind of
   signature move the `-07-22` revert warns against landing unattended.

### Reader 3 — logger + API surface + host→core boundary

8. **[Keep] Logger is a thin, justified, host-injectable sink.** Re-confirmed
   the `setOutputChannelFactory` injection (2 production call sites:
   `extension.ts`, CLI `initPlatform.ts`; console fallback otherwise) and secret
   redaction. The reader flagged the module-level mutable sink registry
   (`logUtils.ts:48-53`) as an embedding hazard for true multi-tenant use —
   **already recorded** (the `-07-03`/`-07-05`/`-07-21` checkpoints and both
   dev/audits name the logger-state item), and accepted for the three current
   single-instance hosts. The `LogRedactionOptions.homeDir/workspacePath`
   path-scrubbing being wired only on the desktop-app path (not the shared
   channel path) is the same item those checkpoints logged and kept. Matches
   `-07-25`'s "one coherent logger" verified-clean finding.

9. **[strategic] The host→core import surface is the single real gap (NS-1).**
   Quantified independently and cross-checked against the ratchet: hosts reach
   **55 distinct `@agent/*` deep specifiers** (`SessionHandle` 39 refs,
   `HostInteractions` 11, `runAgent` 7, …), and
   `config/ratchets/host-agent-import-baseline.json` freezes this at
   **extension 41, CLI 31, desktop 27** distinct specifiers per host. This is the
   north-star NS-1 "no public surface" item; the R-a/R-b ratchets are installed
   and enforcing at a zero-violation baseline, and formalizing the Tier-1 surface
   manifest is `-07-25`'s "Surface simplification / SDK boundary formalization"
   section. `src/agent/index/index.ts` remains the **registry-scoped** barrel
   (accurately docstring'd as "public API for the agent registry"), not the
   core SDK entry point — a mis-scoping to resolve when the Tier-1 manifest lands,
   not a defect. Strategic, sequenced, not applied.

### Reader 4 — subagent boundaries

10. **[Keep] Delegation is already a mature strategy-pattern subsystem.**
    `startChildRunLoop` + `ChildRunStrategy` (native / workflow-script / external
    Claude-agent) + `executionRegistry` lineage + `detachSubagentsOnStop` +
    cost roll-up, with each child owning its own `AgentLaunchContext` / `streamId`
    / trace — matching the SDK `{name, description, tools, prompt} → run()`
    shape. The in-band path (`executeSubagentForDeliveryInBand`,
    `executeStableSubagentInBand`) **already returns `AgentFinalResult`** as an
    awaitable value; the interactive path enqueues a `FollowUpQueue` follow-up
    only because its turn stack has already unwound. The independent split
    candidates (provider families, model resolution, execution-registry/teardown
    cluster, persistence/resume, index/roster behind injected `Deps`) all match
    the ranked split points held since `-06-26` → `-07-23`. **No new split point,
    no reordering.** The depth-cap prerequisite before exposing a recursive
    `delegateTo(...)` still stands.

11. **[refinement, stale cross-ref] The `-07-15` audit's "only a test fake
    exists" note for the workflow-script runner binding is now stale.**
    `createWorkflowScriptAgentRunner` (`workflowScriptAgentRunner.ts:123`) is the
    **live production** binding of the injected `WorkflowAgentRunner` port to
    `executeStableSubagentInBand`, wired at `WorkflowScriptTool.ts:247`. This is
    a factual correction to the earlier record, not new debt: the workflow-script
    engine is the natural first _programmatic_ SDK surface and it already returns
    journaled typed results. No action; recorded so the stale claim isn't carried
    forward.

12. **[strategic] Agent-review findings return via a side channel.**
    `AgentReviewService.executeReview` runs `changeReviewer` as a **top-level**
    tool-use agent session via `runAgent` with `stopAfterCycle: true`. Because
    `runAgent` registers a fresh run without a parent execution ID and does not
    forward `isSubagent`, this path does not exercise subagent lineage,
    detachment, or cost roll-up. Its findings nevertheless stream out mid-run
    through the `report_review_issue` tool into host-mutable state rather than
    on the run result. Returning a typed `{issues[]}` value is therefore a
    candidate for the general agent-result surface, consistent with and gated
    by the same NS-1 boundary work; it is not evidence about the subagent
    boundary itself. Recorded as a strategic candidate; not applied unattended.

## No change lands (by design this pass)

Per the standing "raise the bar — land at least one verified improvement"
directive, this pass considered the two lowest-risk candidates it surfaced
(`createRunScope` inline; the stale-cross-ref cleanup in the `-07-15` audit
prose). **It deliberately lands neither.**

- The `-07-22` checkpoint is the worked example of the hazard: a grep-justified
  "easy" cleanup (narrowing `MapToolRegistry`'s constructor away from its `Map`
  input) was applied, gated, pushed — then **reverted in full** after an external
  Codex review caught an incomplete caller census _and_ a silent-failure
  regression. The lesson: this class of change needs a reviewer _outside_ the
  pass's own fan-out, which an unattended run does not have.
- `createRunScope` is a ~1-LOC net change on the launch path; the stale-cross-ref
  is prose in a historical audit that this checkpoint already corrects in the
  record above. Neither clears the asymmetry (near-zero gain vs. documented
  unattended-revert risk) that makes "record it, do not apply it" correct here.

`MapToolRegistry` re-checked and remains `Map<string, ITool> | Record<string,
ITool>` with the `instanceof Map` branch intact (`ToolTypes.ts:50-51`) — the
reverted state the `-07-22`/`-07-23` checkpoints left. **Do not re-attempt the
narrowing without a deliberate compatibility boundary for `Map` inputs.**

## Verified (this checkpoint)

- Spine invariants at HEAD `5fc03f9`: `src/agent/core/index.ts` **absent** (no
  barrel regression); `IModelHandler = Pick<ModelHandler>`
  (`src/agent/types/IModelHandler.ts:41`); the `Node.exec → createFlow().run`
  shape intact (`ResponseCycleNode.ts:105`).
- Boundary hygiene: **0** `vscode` imports across all declared VS Code-free zones
  (`src/agent`, `model`, `latex`, `tools`, `controllers`, `shared`,
  `replacement`, `eventBus`, `hosts`, `logger`, `platform/interfaces.ts`).
- Ratchets present and enforcing:
  `config/ratchets/host-agent-import-baseline.json` (extension **41**, CLI **31**,
  desktop **27** distinct deep specifiers — read directly this pass) and
  `config/ratchets/knip-baseline.json`.
- Host→core surface re-quantified independently: **55** distinct `@agent/*` deep
  specifiers reachable from `packages/*` across **263** import statements;
  top consumers `@agent/runtime/SessionHandle` (39), `HostInteractions` (11),
  `runAgent` (7).
- `ModelFactory` decorators still single-caller-class per the standing ruling
  (`withReasoningOverride` 1 caller); not re-forensic-counted, not applied.
- `MapToolRegistry` (`src/agent/core/tools/ToolTypes.ts:50-51`) still
  `Map | Record` with the `instanceof Map` branch.
- `workflowScriptAgentRunner.ts:123` `createWorkflowScriptAgentRunner` confirmed
  a **live production** binding (`WorkflowScriptTool.ts:247`), not a test fake.
- Direct `executeAgent` census: three production call sites —
  `src/agent/runtime/runAgent.ts`,
  `src/tools/delegation/nativeSubagentStrategy.ts`, and the lazy import in
  `src/tools/delegation/inBandSubagentExecution.ts`.
- Branch lineage: `f7dded0` is an ancestor of `5fc03f9`; the intervening range
  contains 105 commits.

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched this pass; the standing verification against those docs is carried
  forward, not re-established.
- Caller/override counts other than those in "Verified" come from the fan-out
  readers' greps, **not** re-run to full-`src/`-scope forensic standard. Treat the
  spine invariants and the directly-re-grepped counts as verified; treat wider
  override/caller tables as re-derived-but-not-re-audited.
- This pass did not perform a commit-by-commit audit of the available
  105-commit range `f7dded0..5fc03f9`. It performed a fresh state inspection at
  `5fc03f9` and reconciled that state against the `-07-25` audit and the
  standing rulings instead.
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist (`docs/.vitepress/publicDocs.js`)
  — not a root-level doc, so it does not touch the `docs-root-boundary` gate.
