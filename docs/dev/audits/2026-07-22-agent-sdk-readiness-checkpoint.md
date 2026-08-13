# Agent SDK Readiness — Verification Checkpoint (2026-07-22)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the plan of record
[`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-21` checkpoints (most recently
[`-2026-07-21`](./2026-07-21-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against `claude/eager-noether-2kgehc`
at HEAD `395e229` (v0.39.8, unreleased per `CHANGELOG.md`'s `[0.39.8] -
Unreleased` heading; 11 commits above the `3612630` pin the 07-21
checkpoint recorded). **Correction (Codex, P2): the initial commit census for
this range was itself incomplete** — it named only 5 of the 11 (dependency
bumps #9056/#9058/#9060, the citty refactor #9039, `#9036`) and asserted
"none touch the agent spine," which is false. The 6 omitted commits are
`f71007a` (deletes the dead `mediaAttachmentKinds` export from
`mediaVisionWarning.ts` — spine-adjacent, trivial; the file's other three
exports are untouched), `0dc0f8b` / **#9035** "fix: scope execution writes to
lease owners" (a **substantial** spine rewrite: `executeAgent.ts` ±412,
`executionRegistry.ts` ±206, `runAgent.ts` ±163, plus `AgentRunLifecycle.ts`,
`ExecutionHandle.ts`, `childRunLoop.ts`, `agent/storage/executionLease.ts`
and `executionLifecycle.ts`), `09d5aea` / #9055 (scopes `TextEditorTool.ts`'s
undo-history storage per execution — nesting `fileHistory` under
`executionId` — and adds an execution-registry listener that releases a
finished execution's snapshots; the pre-existing `MAX_HISTORY_PER_FILE = 50`
cap was already present before this commit and is unchanged by it),
`9bc9af2` / #9054 (dedup pass touching `agent/export`,
`agent/implementations/flows/tooluse/nodes/types.ts`,
`agent/runtime/modelHandlerCompatibilityInference.ts`), and `b64b18d` / #9038
(the 07-21 checkpoint's own applied cleanup, already recorded in that
checkpoint). The omitted set is 6 commits: `f71007a`, `0dc0f8b`, `09d5aea`,
`9bc9af2`, `b64b18d`, plus `c08e698` — the **substantive** commit of the two
under PR #9039 (163 insertions, 101 deletions across 5 files); its child
`1b5732a` has an identical tree and contributes no diff, making `1b5732a`,
not `c08e698`, the no-op duplicate (correcting an earlier draft of this doc,
which had the two backwards). The lease-scoping
rewrite (`0dc0f8b`) is the one with real spine-shape risk. **Correction
(Codex, P2): the file census for this commit was itself incomplete** — an
earlier draft of this doc named 8 files; `git diff 0dc0f8b^ 0dc0f8b --
src/agent/runtime src/agent/storage` alone shows **11**:
`executeAgent.ts`, `executionRegistry.ts`, `runAgent.ts`,
`AgentRunLifecycle.ts`, `ExecutionHandle.ts`, `childRunLoop.ts`,
`AgentLaunchContext.ts` (omitted from the earlier count),
`executionLease.ts`, `executionLifecycle.ts`, `executionListing.ts`
(omitted), and `storage/index.ts` (omitted) — and the full commit touches
34 files total, including `src/tools/bash.ts`,
`src/tools/agentCliShared.ts`, and the delegation tool call sites
(`subagentExecution.ts`, `inBandSubagentExecution.ts`,
`WorkflowScriptTool.ts`). This pass's fan-out readers opened only **one** of
those 11 runtime/storage files fresh at `395e229`: `runAgent.ts`.
`RunContext.ts` and `SessionHandle.ts` were also read fresh this pass, but
as part of the general runtime review, not because `0dc0f8b` touched them —
it didn't. The other 10 `runtime`/`storage` files `0dc0f8b` changed
(`executeAgent.ts`, `executionRegistry.ts`, `AgentRunLifecycle.ts`,
`ExecutionHandle.ts`, `childRunLoop.ts`, `AgentLaunchContext.ts`,
`executionLease.ts`, `executionLifecycle.ts`, `executionListing.ts`,
`storage/index.ts`) were **not** opened this pass, so "unchanged since
07-21" is not established for any of them — a real residual gap in this
checkpoint's coverage, not a reassurance, and a future pass should read them
explicitly. As on every prior pass it ran a **fresh,
uninformed four-way fan-out
audit** — four separate readers for (1) `agent/core` + `agent/implementations/flows`,
(2) `agent/modelHandlers` + `toolConversion` + `IModelHandler`, (3)
`agent/runtime` + `logger` + the trace/`SessionEventHub`/`AppSignals` surfaces,
and (4) host↔core surface + SDK-concept alignment (against the fetched
`code.claude.com/docs/en/agent-sdk` docs) + subagent split points — then
reconciled every finding against the adjudicated rulings and the tracked
candidates in the standing checkpoints.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The four fresh, uninformed readers independently
re-reached the standing conclusion (the same reconvergence the 07-21 pass
recorded). Every substantive candidate the fan-out surfaced maps onto an
**already-adjudicated trap** (ruling held), an **already-tracked
strategic / reviewed-train** item, or a **verified false positive**. Two
distinct census failures struck this pass — **neither was actually a
`src/`-only-grep scope problem**, despite this checkpoint initially
describing them that way (Codex, P2, caught the mischaracterization):
`src/test-kernel/` is itself under `src/`, so a plain `grep -rn <symbol> src`
already reaches it. (1) The runtime reader proposed un-exporting
`useRunContext` ("0 external callers"); a full `src/`-scoped grep does find
its two test-kernel importers, so whichever narrower scope the reader
actually searched, it was not "all of `src/`" — the true search boundary
that produced the miss isn't reconstructed here, and this doc should not
assert one. (2) This checkpoint's own `MapToolRegistry` caller census, used
to justify an applied change, undercounted 16 real constructions as 14 — and
a full-repo grep run earlier in the same session already contained all 16
correctly; the "14 across 5" figure that made it into the applied change's
rationale was a transcription error in synthesizing that already-correct
data, not a tool or scope limitation. See "Applied-then-reverted" below.

## Applied-then-reverted this pass — a self-caught verification failure

Per the maintainer's "raise the bar every day — land at least one verified
improvement" directive, this pass initially applied, gated, and pushed one
candidate. An external automated review (Codex, three P2 comments) then
caught that the "verification" was itself incomplete in two distinct ways,
and that the change carried a real safety regression. All three catches were
independently re-verified and the change was reverted in full. Recording this
in detail because it is exactly the failure mode this checkpoint series
exists to catch — this time the recurring error hit the audit-and-apply step,
not just the audit.

**What was proposed and initially applied.** `MapToolRegistry`
(`src/agent/core/tools/ToolTypes.ts:47-61`) accepted
`Map<string, ITool> | Record<string, ITool>` and branched on
`tools instanceof Map ? tools : new Map(Object.entries(tools))`. A grep of
`new MapToolRegistry(...)` was read as showing 1 production + 14 test call
sites across 5 files, all passing `Record`, so the `instanceof Map` arm was
narrowed away (constructor changed to `Record<string, ITool>` only).

**Catch 1 (Codex, P2) — the caller census itself was incomplete.** The actual
full-repo grep returns **16** constructions across **10** files (1 production
and **15** test, not 14, across **9** test files not 5) — the omitted suites
were `ToolUseDispatchInterruption`, `ToolUseRoundFollowUpMedia`,
`DelegationAgentAvailability`, and `DelegationWorktreeAvailability`. All 4
missed suites (33 additional tests) were run after the catch and pass with
`Record`-typed arguments, so the underlying conclusion ("no in-repo caller
passes a `Map`") happened to still hold — but the stated validation scope
("73 tests across five suites") was false. A second, distinct incomplete-grep
error, layered on top of the audit's already-diagnosed recurring failure mode.

**Catch 2 (Codex, P2) — narrowing an exported constructor's accepted input is
not "removing dead code."** `MapToolRegistry` is `export`ed; its `Map` branch
was a documented, explicitly-accepted input shape, not a provably-unreachable
code path. "No current in-repo caller exercises it" is a usage argument, not
an unreachability argument — it says nothing about a type-unsafe or future
caller (an `as any` cast, a dynamically-loaded consumer) that does pass a
`Map`. Worse, the failure mode is **silent**, not a compile error:
`Object.entries(mapInstance)` returns `[]`, so a `Map` input after the change
would silently construct an **empty** registry rather than fail loudly.
Removing the branch traded a real, if narrow, correctness guarantee on an
exported symbol for 2 LOC, with no caller demanding the removal.

**What was reverted.** The constructor is restored to
`Map<string, ITool> | Record<string, ITool>` with the `instanceof Map` branch
intact — byte-identical to the pre-checkpoint code. The class doc-comment is
back to "Map- or Record-backed".

**Verified after revert.** `npm run typecheck` exit 0 — the full command
(all **six** configs: root, test-kernel, extension, CLI, trace-viewer,
desktop; correcting an earlier draft of this doc that under-described the
scope as "root + test-kernel" when only those two direct `tsc` invocations
had been run in the moment); `eslint` clean on the touched file; all **9**
`MapToolRegistry`-constructing suites green — **106 tests**
(`ToolUseDispatchParallel`, `ToolUseToolResolution`, `structuredOutput`,
`BashTool`, `SessionResumeRetrieval`, plus the 4 initially-missed suites:
`ToolUseDispatchInterruption`, `ToolUseRoundFollowUpMedia`,
`DelegationAgentAvailability`, `DelegationWorktreeAvailability`).

**Net effect.** No code change lands this pass after all — the dead-branch
candidate did not survive verification once the verification itself was
corrected. This replaces last pass's "raise the bar" applied-improvement with
a documented non-improvement: a real signature-narrowing change was drafted,
gated on an incomplete test/caller audit, pushed, then reverted after
independent review caught both the incomplete audit and the safety
regression it was masking. The discipline holds — verify before landing, and
re-verify when an outside reviewer disagrees — but this time the "verify"
step needed a second pass from a reviewer outside the checkpoint's own
fan-out.

## Other candidates rejected outright (record — caller counts again)

Two further "easy" fan-out candidates were examined and **rejected**, each an
incomplete-grep or already-adjudicated artifact:

- **`useRunContext` un-export** (runtime reader: "0 external callers, could be
  un-exported"). Full-repo grep shows it imported by
  `src/test-kernel/agent/runtime/RunContext.vitest.ts` and
  `AgentLaunchContext.vitest.ts` via `@agent/runtime/RunContext` — the export
  is load-bearing for the test seam. **Keep.** (Both files are under `src/`,
  so this was not a plain `src/`-scope miss; the actual search the reader ran
  was narrower than that, and its exact boundary isn't reconstructed here —
  see the Verdict section's correction.)
- **The Anthropic empty-response magic number**
  `responseObject.usage.output_tokens === 3`
  (`modelHandlerAnthropic.ts:973`, model-handler reader re-surfaced it as a
  fragile heuristic). This is **already recorded** — the
  [`-2026-07-18`](./2026-07-18-agent-sdk-readiness-checkpoint.md) checkpoint
  (item on the `anthropic/` handler) already flagged the undocumented constant
  and its "worth a content-based check" fix as "not unattended-safe, cheap
  when a maintainer picks it up." Ruling held; not re-flagged as new.

## Fan-out findings mapped to standing adjudications — all held

Nothing below is new debt; each was independently re-derived and matches a
prior ruling.

- **`ModelHandler.ts` ~1,931-LOC base tangling ~7 concerns** — model-handler
  reader re-derived it; the `#7101` triage doc-comments (the ~40-line
  justifications per capability getter) are a _feature_ preventing
  re-litigation. **Reviewed-train** (the standing `runTurn`/`streamTurn`-façade
  decomposition item); do not collapse. Optional future: extract the
  credential-routing / token-count-template blocks into injected collaborators —
  size/cohesion, not duplication.
- **`IModelHandler` port width (~41 members)** — the message-opacity /
  `query()`-alignment tension the north-star already records; the six
  provider-trait predicates stay overridable per the `#7101` triage (not
  foldable into a static `capabilities` object — their values are computed
  per-handler at runtime). **Reviewed-train / strategic**, gated with the
  neutral-transcript lever.
- **`toolConversion.ts` one-way converters** — model-handler reader confirmed
  **no round-tripping**; each of the six converters has a distinct provider
  caller and real per-format logic (`flattenTopLevelUnion`, `stripDollarSchema`
  work around documented OpenAI/Gemini 400s). **Keep.**
- **Anthropic handler delegates to `@anthropic-ai/sdk`** — streaming via
  `client.beta.messages.stream` + `finalMessage()`, retries via
  `isAutoRetryManagedByProvider() === true`, caching via SDK `cache_control`.
  Very little is re-implemented; the document-continuation loop it _does_ own
  is required by the multi-provider unification. **Keep.**
- **OpenAI-compatible subclasses** (`ReasoningModelHandlerOpenAI` + the
  per-provider handlers) — each carries genuine wire-format divergence; the
  intermediate base has 4 subclasses. **Keep** (the `DashScope`/`XAI`/`GLM`
  consolidation remains the standing reviewed-train note).
- **`ResponseCycleFlow`/`ToolUseRoundFlow` primitives, `createResponseCycleFlow`
  /`createToolUseRoundFlow` factories, `withModelClient`, `ModelInvocationNode`,
  `IToolUseSession`, `IToolRegistry`** — all re-derived and match the held
  rulings: the factories _are_ the prescribed `Node.exec() → createFlow().run()`
  shape (fresh stateful node graph per round); `withModelClient` is the
  load-bearing live-`client` getter for relay-401 rebinding; `IToolUseSession`
  is a legitimate single-impl `core → implementations` seam. **Correction
  (Codex, P2): `IToolRegistry` is no longer single-impl** — besides
  `MapToolRegistry`, `src/tools/structuredOutput.ts:228-236`'s
  `buildTerminalToolRegistry` returns a second, structurally-typed
  implementation (a per-run overlay resolving `submit_output` to the
  run-scoped terminal tool while delegating everything else to the base
  registry, so concurrent runs don't share one terminal tool). The **Keep**
  verdict is unchanged — both are genuine, load-bearing implementations — but
  the "single-impl" characterization was stale (this pass's own agent-core
  reader had already surfaced the second implementation; the checkpoint's
  synthesis dropped it when carrying forward the 07-21 phrasing).
- **Four event/subscribe surfaces** (`AgentTrace.subscribe`,
  `SessionEventHub.subscribe`, `SessionHandle.onResult`, `AppSignals.on`) —
  the runtime reader re-derived the run-`result` overlap. This is the standing
  **Observability / unified-stream** strategic item; the 07-21 pass already
  refined it (the genuine parallel registries are interaction/presentation;
  `emitRunFact` is _not_ a third delivery surface; the broker-side pre-dispatch
  filter in `SessionEventHub.emit` must be preserved). No new action.
- **Logger** — thin, justified sink (host-injectable channel factory, secret
  redaction, dedup); `redaction.ts` guards security properties (desktop
  path-redaction caller + the `satisfies Record<ApiKeyProviderId>` exhaustiveness
  ratchet). **Keep** — matches the 07-21 "withdrawn as a cleanup candidate"
  ruling.
- **Subagent split points** — delegation is already a mature strategy-pattern
  subsystem (`startChildRunLoop` + `ChildRunStrategy` + `executionRegistry`
  lineage + `detachSubagentsOnStop`); `review` is already an isolated tool-use
  agent (the reference split), `agentCreator` already runs on an isolated
  helper-model kit, goal-continuation is hook-shaped not subagent-shaped, and
  `followUp`/`export` are correctly not candidates. Ranked split points
  **unchanged** from `-06-26` → `-07-21`. The depth-cap prerequisite (derive a
  depth counter from lineage, then gate it) before exposing a recursive
  `delegateTo(...)` still stands.

## No-public-surface — the central item, still the north-star's NS-1

The host→core import surface remains the one real SDK-readiness gap (hosts
still deep-import ~26 of 51 `runtime/` files — a distinct metric, the union
count of directly-imported `@agent/runtime/*` files, not a per-host
specifier count). The checked-in per-host deep-import baseline
(`config/ratchets/host-agent-import-baseline.json`, verified identically at
both the `3612630` and `395e229` pins) is **extension 41, CLI 31, desktop
27** — correcting an earlier draft of this doc, which wrote "26" for desktop
by carrying forward the 07-21 checkpoint's own prose table without
re-checking it against the checked-in baseline file (the actual R-b
enforcement artifact). This is **not new** and is **not
eroding unfenced** anymore: Step 0's R-a (inbound host-import freeze in
`eslint.config.mjs`) and R-b (frozen per-host deep-import baseline +
`hostAgentDeepImportRatchet.vitest.ts`) are both installed and enforcing at a
zero-violation baseline, and width dropped on all three hosts last window.
Step 1 (the TD-2 contract-residue quartet + executable consumer-contract
suite) and Step 3 (packaging, gated on a real external consumer) remain the
sequenced path. Nothing this pass changes that sequencing.

## Retracted — "MCP tool exposure" was not a genuine gap

An earlier draft of this checkpoint proposed exposing TeXRA's tool registry
as an in-process MCP server as a "genuinely-uncaptured observation,"
supported by a grep scoped to `docs/proposals/` only. **That grep was
incomplete and the premise was wrong (Codex, P2 ×3).** A detailed PRD already
covers this exact ground: [`docs/prds/2026-05-04-prd-cli-app.md`](../../prds/2026-05-04-prd-cli-app.md)
§24, `texra mcp serve` — a stdio MCP server exposing three tools
(`run_workflow`, `run_chat`, `list_agents`) to any MCP-speaking caller
(Claude Code, Codex, opencode), with a `McpHostAdapter`, a per-`tools/call`
`RunContext`, and an MCP-mode approval policy forced to `never`/`yolo` (no
TTY for interactive prompts). It was promoted to v1 scope in that PRD's round
2, then explicitly deferred out of the v1.x roadmap in round 4 by direct user
instruction ("Don't do MCP yet," reinforced 2026-05-09) — a deliberate
deprioritization, not an oversight.

The retracted draft also elided real design problems that PRD's `run_chat`
tool already has to solve and a from-scratch "wrap the registry" version
would not, for free: (1) `parallelSafe` is consumed today only as an
in-process ordering barrier inside `ToolUseDispatchNode` — MCP's
read-only/destructive/idempotent tool annotations are advisory metadata to
the calling client, not a serialization mechanism, so directly re-exporting
registry entries would not preserve that barrier for a client issuing
concurrent `tools/call`s; (2) an in-process server is reachable only from
the embedded `claude_code` process, not from an external CLI/SDK consumer,
which needs an actual stdio/HTTP transport (exactly what `texra mcp serve`
provides); (3) exposing the full default registry would also expose
`claude_code`/`delegate_agent`/the workflow delegation tools themselves,
and — since this same checkpoint's "Subagent split points" item above notes
delegation has no depth cap yet (only parent lineage, not a counted depth) —
a bypassed or approved recursive call could spawn children indefinitely.

**Do not re-flag MCP tool exposure as an uncaptured gap in a future
checkpoint.** If it becomes relevant again, start from PRD §24, not from this
retracted section.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is
healthy at `395e229` (v0.39.8, unreleased); a fresh four-way fan-out reconverged on the
standing verdict. **No net code change lands this pass.** The one candidate
this pass initially applied — narrowing `MapToolRegistry`'s constructor away
from its `Map` input — was pushed, then **reverted** after an external review
(Codex, P2 ×2) caught both an incomplete caller census (16 constructions
across 10 files, not 14 across 5) and a real silent-failure regression on the
exported class's accepted `Map` input; see "Applied-then-reverted" above. Two
further candidates were verified and rejected outright (`useRunContext`
export is needed by two test files; the `output_tokens === 3` heuristic is
already recorded in `-07-18`). This checkpoint's own host-import
boundary-width figure is also corrected, **55 → 54** (Codex, P2): the raw
token grep counted a comment-only `@agent/review` reference
(`agentReviewCommands.ts:6`, prose, never used as a real import specifier)
as if it were one. This doc also self-corrected three further accuracy
issues an external review caught after the first draft: an incomplete
intervening-commit census that wrongly claimed none of the 11 commits since
the 07-21 pin touch the agent spine (one, `0dc0f8b`/#9035, is a substantial
execution-lease rewrite), a stale "single-impl" characterization of
`IToolRegistry` (it has two: `MapToolRegistry` and
`buildTerminalToolRegistry`'s overlay), and a five-checkpoint-old reference
to a `followUpResumeDetection` symbol that does not exist in the tree — see
the corresponding sections above and the README fix alongside this change.
A fourth review round caught three more: the desktop deep-import baseline is
**27**, not the "26" this doc carried forward from the 07-21 checkpoint's
prose table without checking it against the checked-in
`config/ratchets/host-agent-import-baseline.json`; the claim that
`childRunLoop.ts` was read fresh this pass was false (only `runAgent.ts`,
among the 11 `runtime`/`storage` files `0dc0f8b` touched — itself corrected
up from an initially-undercounted 8 — was actually opened); and this
checkpoint's own "MCP tool exposure" observation has been **retracted in
full** — a detailed PRD (`docs/prds/2026-05-04-prd-cli-app.md` §24) already
covers that ground and deliberately defers it, so it was never a gap to
begin with (see the retraction section above). Every remaining item is
reviewed-train (`ModelHandler`
decomposition, the `IModelHandler` port-width facets kept overridable per the
`#7101` triage) or strategic/gated (the unified event stream preserving
broker-side filtering, the `HostInteractions` 7/7 required-methods conversion
behind Step 1, the frozen `GoogleGenAI` handler gated on `#7097` +
transcript-format retirement, the no-public-surface Steps 1–3). Do not re-open
the traps; do not re-flag `useRunContext`, `IToolRegistry`, or `IModelHandler`
as dead (each has a live caller or a test seam that a narrower-than-`src/`
search can miss); do not re-attempt the `MapToolRegistry` narrowing without
also providing a deliberate compatibility boundary for `Map` inputs.
**Correction (Codex, P2): retire `followUpResumeDetection` from this
keep-list — it names a symbol that does not exist at `395e229`.** No file or
export by that name is in the tree (confirmed: no matching path, and no
non-stale grep hit); it had been carried, unverified, through every
checkpoint since `-07-10` on the strength of a stale table entry in
`src/agent/runtime/README.md` (now corrected in this same change). The
resume-detection behavior this was meant to protect is implemented today as
the private `lazyDetectWaitingStatus` function in
`packages/extension/src/commands/agent/followUpCommand.ts` — a real,
live-caller symbol, but a different one, in a different file, than the
five-checkpoint-old claim named.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `395e229`: `src/agent/core/index.ts` **absent**
  (no barrel regression); `IModelHandler` = `Pick<ModelHandler>`
  (`src/agent/types/IModelHandler.ts:41`); the `Node.exec → createFlow().run`
  shape intact. **Retracted (Codex, P2 — twice, as the file count itself
  needed a second correction): "delegation strategy subsystem intact" is not
  a verified claim this pass** — `executionRegistry.ts`, `childRunLoop.ts`,
  and 8 other runtime/storage files `0dc0f8b` changed (10 of the 11 total,
  all but `runAgent.ts`) were not opened (see the acknowledged coverage gap
  above); an admitted gap is not a reconfirmed-clean result, and this bullet
  should not have implied otherwise.
- Boundary width: hosts still deep-import **54** distinct `@agent/*`
  specifiers (union, a different metric than the per-host baseline below) /
  26 of 51 `runtime/` files (independent recount, ±1 vs a differently
  tokenized census). Corrected from an initial raw-token count of 55 (Codex,
  P2): the token grep matched a comment-only `@agent/review` reference
  (`packages/extension/src/commands/review/agentReviewCommands.ts:6`, doc-comment
  prose, not an import) as if it were a real specifier — confirmed via
  `grep -rn "from '@agent/review'"` returning zero hits for that bare path.
  Step 0 R-a/R-b ratchets present and enforcing.
- Per-host deep-import baseline corrected: `config/ratchets/host-agent-import-baseline.json`
  reads **extension 41, CLI 31, desktop 27** at both `3612630` and `395e229`
  (verified directly via `git show <sha>:config/ratchets/host-agent-import-baseline.json`
  at each pin) — not the "26" for desktop this doc's first draft carried
  forward from the 07-21 checkpoint's own prose table without re-checking it
  against the checked-in file.
- `MapToolRegistry` (`src/agent/core/tools/ToolTypes.ts:47-61`) — narrowed to
  `Record<string, ITool>`, pushed, then **reverted** to
  `Map<string, ITool> | Record<string, ITool>` (byte-identical to
  pre-checkpoint) after Codex P2 review. Full-repo recount after the catch: 16
  constructions across 10 files (1 production + 15 test across 9 test files,
  not 14 across 5 as first reported). `npm run typecheck` exit 0 — the actual
  full six-config command re-run post-revert (root, test-kernel, extension,
  CLI, trace-viewer, desktop), `eslint` clean, all 9 constructing suites
  green — 106 tests.
- Rejected candidates verified: `useRunContext` imported by
  `RunContext.vitest.ts` + `AgentLaunchContext.vitest.ts` (export required,
  both files under `src/`); `output_tokens === 3` already flagged in
  `-2026-07-18`.
- Commit-census correction: `git log 3612630..395e229` is 11 commits, not the
  5 this doc first named. The 6 omitted — `f71007a`, `0dc0f8b`/#9035,
  `09d5aea`/#9055, `9bc9af2`/#9054, `b64b18d`/#9038, plus `c08e698` (the
  substantive citty commit, not its no-op child `1b5732a`, which an earlier
  draft mislabeled as the duplicate — verified via `git show -s --format=%T`
  on both SHAs: identical tree, so `1b5732a` contributes no diff) — include a
  substantial spine rewrite (`0dc0f8b`). **Correction (Codex, P2): the file
  census for `0dc0f8b` was itself incomplete** — an earlier draft of this
  doc named 8 files;
  `git diff 0dc0f8b^ 0dc0f8b -- src/agent/runtime src/agent/storage` shows
  **11**: `executeAgent.ts`, `executionRegistry.ts`, `runAgent.ts`,
  `AgentRunLifecycle.ts`, `ExecutionHandle.ts`, `childRunLoop.ts`,
  `AgentLaunchContext.ts`, `executionLease.ts`, `executionLifecycle.ts`,
  `executionListing.ts`, and `storage/index.ts` (the last 3 were omitted);
  the full commit touches 34 files total, also including `src/tools/bash.ts`
  and the delegation tool call sites. Of the 11 `runtime`/`storage` files,
  this pass's readers opened only `runAgent.ts` fresh at `395e229` and found
  no new debt in it; the other 10 were **not** opened this pass — an
  acknowledged coverage gap, not a reverified-clean result.
- `IToolRegistry` implementation count corrected: 2, not 1 —
  `MapToolRegistry` (`ToolTypes.ts:47`) and `buildTerminalToolRegistry`'s
  returned overlay object (`src/tools/structuredOutput.ts:228-236`). **Keep**
  verdict unchanged; only the single-impl characterization was stale.
- `followUpResumeDetection` retired from the standing keep-list: no such
  file/export exists at `395e229` (confirmed by path search and grep); it
  had propagated unverified since the `-07-10` checkpoint via a stale entry
  in `src/agent/runtime/README.md`'s module-map table, corrected in this same
  change. The live implementation is `lazyDetectWaitingStatus` in
  `packages/extension/src/commands/agent/followUpCommand.ts`.
- MCP-exposure observation: no **prior** proposal mentioned exposing the
  TeXRA tool registry as an MCP server (grep across the pre-existing
  `docs/proposals/` tree, before this checkpoint's own MCP section was
  written) — this checkpoint is the first; `claude_code` tool confirmed at
  `src/tools/claudeAgent.ts` importing `@anthropic-ai/claude-agent-sdk`.
- This checkpoint is added under `docs/proposals/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.
