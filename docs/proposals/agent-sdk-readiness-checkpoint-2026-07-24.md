# Agent SDK Readiness — Verification Checkpoint (2026-07-24)

**Status:** Verification checkpoint. Read alongside the canonical
[`agent-sdk-readiness.md`](./agent-sdk-readiness.md), the plan of record
[`agent-sdk-north-star.md`](./agent-sdk-north-star.md), the detailed
[`../agent-sdk-readiness-audit.md`](../agent-sdk-readiness-audit.md), the
trace-surface companion
[`agent-trace-sdk-surface.md`](./agent-trace-sdk-surface.md), and the
`-2026-06-25` → `-2026-07-23` checkpoint chain (most recently
[`-2026-07-23`](./agent-sdk-readiness-checkpoint-2026-07-23.md)).

This pass re-verified the standing audit against branch
`claude/eager-noether-0h5i27` at HEAD `49534ea` (v0.39.9 bump, #9105;
`CHANGELOG.md` carries `[0.39.8]` as the last dated release). HEAD is **21
commits above the `f7dded0` pin** the 07-23 checkpoint recorded, and `f7dded0`
is confirmed an ancestor of HEAD. The 07-23 checkpoint itself landed in this
range (`81d634f`, #9089).

**Run context (honesty note).** This was an **unattended scheduled run** with
**no external adversarial review available** (no Codex second pass — the same
lever the 07-22 checkpoint relied on to catch its applied-then-reverted
mistake, and whose absence the 07-23 pass also recorded). It ran a **fresh,
uninformed four-way fan-out audit** — four independent readers briefed only
with the repo's anti-abstraction rules and the task's own framing (identify
abstractions to remove, simplify the surface, design subagent split points),
and **deliberately not** with the standing adjudications — over (1)
`agent/core` + `agent/runtime` + `agent/implementations/flows` +
`types/IModelHandler`, (2) `agent/modelHandlers` + `toolConversion` +
`modelHandlerValidation` + `IModelHandler` + `model/`, (3) `logger` +
`platform` + the host↔core import surface across all three host packages, and
(4) the subagent/delegation subsystem + the YAML agent roster. Findings were
then reconciled against the adjudicated rulings and the tracked candidates in
the standing checkpoints. This pass **applies no code change** — see "No change
lands (by design this pass)" below.

Note on fan-out width: this pass ran the **full four independent lenses**,
including a dedicated host↔core surface reader run as its own fourth lens —
closing the specific coverage gap the 07-23 checkpoint flagged (it managed only
a three-way fan-out and folded the surface reader into reader 3).

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** Four fresh, uninformed readers — none briefed on
the standing rulings — independently re-reached the standing conclusion, the
same reconvergence every pass since `-06-26` has recorded. **Every substantive
candidate the fan-out surfaced maps onto an already-adjudicated trap (ruling
held), an already-tracked strategic/gated item, or the reverted 07-22 change.**
The fan-out surfaced **zero genuinely-new actionable debt.** Two of the four
readers independently re-derived the two single largest strategic items
(`IModelHandler` port width; the host deep-import surface) without prompting —
corroboration of the standing record, not new debt.

## Fan-out findings mapped to standing adjudications — all held or non-actionable

Each item is tagged **[Keep]** (matches a prior no-change ruling),
**[strategic]** (matches a tracked gated item), or **[reverted]** (matches the
07-22 applied-then-reverted change). There are no **[new]** actionable items
this pass.

1. **[Keep] `IModelHandler` is a `Pick<ModelHandler>` mirror, not a boundary.**
   Two independent readers (core + model-handler) flagged that the port
   reproduces ~40 members of a single concrete class hierarchy
   (`src/agent/types/IModelHandler.ts:35-41`, `Pick<ModelHandler<…>, …>`
   re-confirmed at line 41). The model-handler reader's own conclusion was that
   this is a _surface-shape observation, not a delete_ — auto-derived via
   `Pick`, so it cannot drift from the base, and a real SDK port would separate
   the ~10–12-member invocation contract from the node-facing message-shaping
   helpers. This is exactly the standing **[strategic]** port-width item (the
   message-opacity / `query()`-alignment tension; 07-23 item 5), gated behind
   the packaging steps. **No new action.**

2. **[Keep] core/runtime has no removable pass-through wrappers.** The core
   reader flagged the nested PocketFlow graphs (`ToolUsePersistedFlow` wrapping
   an inner round `Flow`), the single-caller `createResponseCycleFlow` /
   `createToolUseRoundFlow` factories, and the `prep/exec/post` DTO ceremony as
   candidate indirection. Each was re-examined against the held ruling: the
   factories have exactly the sanctioned two callers each
   (`ResponseCycleNode.ts:104`, `ToolUseCycleNode.ts:101` — the
   `Node.exec → createFlow().run` shape, verified intact), the DTO split and the
   two-level graph are the framework's replay/resume contract (load-bearing for
   persistence), not ceremony. Matches 07-23 item 1 and the rulings carried
   since `-07-18`/`-07-21`. **No new action.**

3. **[reverted] `IToolRegistry` / `MapToolRegistry` narrowing.** The core reader
   proposed collapsing the one-implementation `IToolRegistry` toward a plain
   `Map` and dropping `has()`. This is **the precise change applied, gated,
   pushed, and then reverted in full on 07-22** after an external Codex review
   caught an incomplete caller census and an `Object.entries(mapInstance) → []`
   silent-failure regression. `MapToolRegistry` re-checked at HEAD and remains
   `Map<string, ITool> | Record<string, ITool>` with the `instanceof Map` branch
   intact (`src/agent/core/tools/ToolTypes.ts:47-61`) — the reverted state
   holds. **Do not re-attempt without a deliberate compatibility boundary for
   `Map` inputs.**

4. **[Keep] `ModelHandler.ts` is a real shared base; provider subclasses carry
   genuine logic.** The model-handler reader confirmed the base-class virtuals
   are overridden by 2–6 subclasses each (genuine polymorphism, not
   single-override template ceremony), and that the OpenAI-compatible subclasses
   are **not** collapsible to config: `modelHandlerKimi` (192 LOC) calls a native
   token-count API and resolves Moonshot request params; `modelHandlerDeepSeek`
   (106 LOC) carries thinking-param and role-merge quirks. `modelHandlerDashScope`
   (14 LOC, one `convertContentToString` flag) is the one near-pure-config shim,
   and the `convertContentToString` / `mergeConsecutiveRoles` protected-readonly
   flags are already the config-as-data shape. The only genuinely dead override
   the reader found is `modelHandlerXAI.extractResponse`
   (`modelHandlerXAI.ts:37-51`), which adds only a `logger.debug` before
   returning `super`'s result unchanged (~15 LOC) — a real but ~near-zero-value
   micro-cleanup on the model-handler spine, deliberately **not** landed
   unattended (see below). Matches the `#7101`-triage reviewed-train ruling
   (07-23 item 4).

5. **[strategic] `toolConversion.ts` / `modelHandlerValidation.ts` are shared,
   not pass-through.** `convertToolSchema` has 3+ production callers; each
   `to<Provider>Tools` has one caller inherently (one wire format per provider)
   and is re-used by tests. `modelHandlerValidation` is a real 8th `ModelHandler`
   subclass used by `runtime/ModelFactory.ts` as the CLI packaged-runtime
   validation gate — single caller **by design**. Consistent with the standing
   "justified shared / justified single-home" rulings. **No action.**

6. **[strategic] No `@agent/runtime` barrel; hosts deep-import the run surface.**
   The surface reader independently re-derived NS-1: the three hosts reach
   directly into the `@agent/runtime/*` cluster (`SessionHandle`,
   `AgentRuntimeHost`, `HostInteractions`, `runAgent`, `executeAgent`,
   `resolveAndResumeStream`, …) as scattered leaves rather than one curated
   entrypoint. This is **the** one real gap, already the north-star's NS-1, and
   already fenced: `config/ratchets/host-agent-import-baseline.json` freezes the
   per-host distinct-specifier width (extension 41, CLI 31, desktop 27 at HEAD,
   verified directly this pass). **Site-level verification added this pass** (the
   incremental record contribution): the surface reader's ranked worst-offender
   leaks — `commands/agent/agentCreatorCommands.ts →
   @agent/implementations/flows/agentCreator/agentCreatorFlow`, `frontend/media/
   audio.ts → @agent/modelHandlers/openai/modelHandlerOpenAI`, and the CLI status
   bar's `@agent/modelHandlers/support/contextUtilization` — are **all already
   present in the frozen baseline** (`agentCreatorFlow` and `modelHandlerOpenAI`
   in the extension list; `contextUtilization` in the CLI list). The ratchet the
   prior checkpoints assert covers this gap in aggregate is confirmed here to
   cover the concrete worst individual sites. Reduction remains Step-2/Step-3
   packaging work, gated on a real external consumer. **No new action.**

7. **[Keep] Logger is a thin, justified sink.** The surface reader re-confirmed
   the single-emission-point design (`logUtils.ts:119-136` `writeLine`, the
   `makeLogFn`/`logAt` forwarder shared by 4 level fns across 168 importers), the
   host-injectable channel factory (`setOutputChannelFactory`, wired by the two
   Node hosts), the single-caller-but-deliberate `createChannelWriter`
   dependency-inversion seam, and the one cohesive `redactSecrets` pass. Matches
   the `-07-18`/`-07-21` "withdrawn as a cleanup candidate" ruling. **No action.**

8. **[strategic] `Platform` port carries a few single-consumer capability
   ports.** The surface reader noted `fileLocks` (1 caller,
   `executionLease.ts:161`), `toolMissingHandler` (1 caller, VS Code-only,
   already doc-flagged at `platform.ts:51-56`), and `toolAvailability` (1 module)
   are capability ports, not the "shared across hosts" services the object mostly
   holds. This is honest-labeling housekeeping the port doc already applies to
   `toolMissingHandler`; it is not debt and not blocking. **No action** (optional
   doc-comment consistency only).

## Subagent split points — unchanged

The dedicated subagent reader (uninformed of prior rulings) independently
concluded that **TeXRA already ships a mature, first-class subagent model — a
superset of the SDK's**, not an aspiration to build. The engine is
`src/tools/delegation/` (`delegate_agent`, `delegate_workflow`,
`delegate_workflow_script`) driven by the coordinator
`reference-agents/orchestrator.yaml`, with isolated per-subagent context, bounded
per-agent YAML toolsets, async follow-up delivery, durable resume/checkpointing,
parallel fan-out (the QuickJS `workflowScript` sandbox with `parallel()`/
`pipeline()`), and cost roll-up to the parent. `src/tools/claudeAgent.ts` already
delegates to `@anthropic-ai/claude-agent-sdk` directly. The reader's ranked
candidates — the three provider families as cleanly separable units, model
resolution, the execution-registry/teardown cluster, persistence/resume, review
(reviewer→coordinator→fixer), and index/roster behind injected `Deps` — all match
the split points held since `-06-26` → `-07-23`. The reader's proposed
"promote review / agentCreator / goal-loop to dispatchable subagents" is the same
seam prior passes recorded; the anti-seams it named (the followUp queue +
`childRunLoop` + native-strategy runtime; reflection-flow internal nodes; the
goal-loop cadence modifier; the roster config controller) match the standing
anti-seam list. The depth-cap prerequisite before exposing a recursive
`delegateTo(...)` still stands. **No new split point, no reordering.**

## No change lands (by design this pass)

Per the standing "raise the bar — land at least one verified improvement"
directive, this pass considered the two lowest-risk micro-cleanups the fan-out
surfaced: deleting the dead `modelHandlerXAI.extractResponse` override (item 4,
~15 LOC, drops a debug log) and trimming the historical narrative in
`features.ts:6-17`. **It deliberately lands neither**, for the reasons specific
to an unattended run that the 07-22 and 07-23 checkpoints both established:

- The XAI override sits **on the model-handler construction/extraction spine** —
  the exact class of change the 07-22 revert warns against landing on only a
  single fan-out's grep, with no external reviewer present. Its removal changes
  observable behavior (a debug log line disappears) for ~zero structural gain.
- The `features.ts` doc trim is genuinely safe (comment-only), but it is a
  cosmetic change to a file whose current text is harmless; landing a
  comment-only edit purely to satisfy the "one improvement" directive is the
  kind of make-work the fewer-elements discipline discourages, and it still
  carries the unattended-run "no reviewer" caveat for anything touched.
- The asymmetry (near-zero gain vs. a documented revert-risk pattern on the
  spine) makes **"record it, do not apply it"** the correct call for an
  unattended checkpoint — consistent with 07-23's handling of the `ModelFactory`
  decorators.

Both micro-cleanups are recorded here as ready-to-land candidates **for an
attended pass with external review** (delete XAI's `extractResponse`; trim the
`features.ts` header comment), not blockers.

## No-public-surface — still NS-1, still the one real gap

The host→core import surface remains the single real SDK-readiness gap. Step 0's
R-a (inbound host-import freeze) and R-b (frozen per-host deep-import baseline)
are installed and enforcing at a zero-violation baseline
(`config/ratchets/host-agent-import-baseline.json`: extension 41, CLI 31,
desktop 27 at `49534ea`, verified directly). Step 1 (the TD-2 contract-residue
quartet + executable consumer-contract suite) and Step 3 (packaging, gated on a
real external consumer) remain the sequenced path. Nothing this pass changes
that sequencing.

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched this pass; the standing `-07-22` verification against those docs is
  carried forward, not re-established.
- Per-method override counts come from the fan-out readers' greps, **not** re-run
  to the forensic full-`src/`-scope standard the `-07-22` census-correction
  discipline demands. The 07-23 note that a fan-out reader's `sdkErrorTagger`
  count was off by one (6 vs the correct 7) is why soft override tallies are
  **omitted** here rather than carried into the record; treat the directly
  re-grepped spine invariants and the baseline counts as verified, the wider
  tables as re-derived-but-not-re-audited.
- Host distinct-specifier counts: the surface reader's raw module tallies
  (extension 42 / CLI 31 / desktop 26) differ by ±1 from the ratchet baseline
  (41 / 31 / 27); this is counting-methodology noise (the ratchet's
  distinct-`@agent/*`-specifier definition vs the reader's per-file module
  count), de-scoped per the prior discipline. The **ratchet file** is the
  authority and is intact and enforcing.
- The 10-of-11 `runtime`/`storage` files that `0dc0f8b`/#9035 touched, flagged
  as not-opened by the `-07-22` and `-07-23` passes, were **not** opened this
  pass either — the acknowledged coverage gap persists; a future pass should read
  them explicitly.

## Verified (this checkpoint)

- Spine invariants at HEAD `49534ea`: `src/agent/core/index.ts` **absent** (no
  barrel regression); `IModelHandler = Pick<ModelHandler>`
  (`src/agent/types/IModelHandler.ts:41`); the `Node.exec → createFlow().run`
  shape intact — `createResponseCycleFlow` / `createToolUseRoundFlow` each have
  exactly the two sanctioned callers (`ResponseCycleFlow.ts` / `ResponseCycleNode.ts:104`;
  `ToolUseRoundFlow.ts` / `ToolUseCycleNode.ts:101`), no wrapper between node and
  flow.
- `MapToolRegistry` (`src/agent/core/tools/ToolTypes.ts:47-61`) still
  `Map | Record` with the `instanceof Map` branch — the 07-22 reverted state
  holds at `49534ea`.
- `IToolRegistry` has exactly one implementer (`MapToolRegistry`,
  `src/agent/core/tools/ToolTypes.ts`).
- R-b baseline present and enforcing:
  `config/ratchets/host-agent-import-baseline.json` reads extension 41, CLI 31,
  desktop 27; the three ranked worst-offender leak specifiers
  (`agentCreatorFlow`, `modelHandlerOpenAI` in extension; `contextUtilization` in
  CLI) are all present in the baseline (site-level coverage confirmed).
- Subagent subsystem present: `src/tools/delegation/` (`delegate_agent` /
  `delegate_workflow` / `delegate_workflow_script`),
  `reference-agents/orchestrator.yaml`, `src/tools/claudeAgent.ts` (delegates to
  `@anthropic-ai/claude-agent-sdk`).
- Commit range: `git rev-list --count f7dded0..HEAD` = **21**; `f7dded0`
  confirmed an ancestor of `49534ea`; the 07-23 checkpoint (`81d634f`, #9089) is
  in the range.
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
