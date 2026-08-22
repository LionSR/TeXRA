# Agent-SDK readiness — re-verification pass (2026-08-22)

> **Status:** Written 2026-08-22 against branch HEAD `d455149`; §8 records a
> follow-up refactor landed later the same day at the maintainer's request,
> mirroring `-08-21 §7`. The scheduled audit routine re-ran the standing
> question — "review the agent core, model handler, logger, and surface for
> unnecessary abstraction and unready surface; design subagent boundaries" —
> against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the three immediately-prior passes
> ([`-08-19`](./2026-08-19-agent-sdk-readiness-reverify.md) at `391033e`,
> [`-08-20`](./2026-08-20-agent-sdk-readiness-reverify.md) at `74fab00`,
> [`-08-21`](./2026-08-21-agent-sdk-readiness-reverify.md) at `c48e5cb`). This
> pass re-derived the verdict from four fresh, independent area audits (core,
> model handlers, logger, surface + subagents) rather than a diff of the prior
> entry. It reached the **same top-line verdict by an independent route — the
> alignment holds** — but, unlike the three prior green passes, it also surfaced
> **two concrete behavior-preserving removals** (one on the public `IModelHandler`
> port) and a **now-templated path to close the provider-SDK-type leak** (§4).
> The two removals (§4a, §4b) were landed at the maintainer's request — see §8
> for the diff and validation; the leak-fix template (§4c) was **not** landed,
> being design-gated rather than mechanical. Every claim below carries a
> `file:line`, config path, or count checked at `d455149`; §8 carries the
> post-landing state.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are, with the narrow exceptions in §4, not present; the exemplary deep modules
(`ModelCell`, `SessionEventHub`, `PersistedFlow`, `AgentRunLifecycle`,
`childRunLoop`) are all things you would keep if designing from scratch. The
`-08-21 §7` Tier-1 door consolidation is present and stable at HEAD (four of
eight doors in place; host deep-import counts hold at their post-consolidation
floor). What is new this pass is honest, bounded, and shovel-ready — not a
reversal of the green verdict but a sharpening of it: the model-handler layer
carries **one genuine pass-through wrapper on the port** (§4a) that the prior
passes' core-focused audits had not reached, and the provider-type leak that
`-08-21 §4.4` named as the floor on the SDK package's specifier count now has a
verified, in-tree fix template (§4c). At the maintainer's request the two
mechanical removals (§4a, §4b) were landed this session (§8); the leak-fix
template stayed unlanded because closing it is a manifest-design decision, not
a mechanical move.

## 1. Every `-08-21` tracked fact re-verifies at `d455149`

| Item                               | `-08-21` state                                 | `d455149` state                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **L-3** (dead redaction branch)    | closed; `redactSecrets` single-arg             | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`); no options branch.                                                                             |
| **L-2** (process-global log sink)  | module-singleton, deliberate; no platform port | **unchanged, and re-confirmed deliberate.** `platform.ts:31-34` documents logging as "its own subsystem"; no `platform().log` port. `logUtils.ts` 256 LoC.                                             |
| **§7 Tier-1 doors**                | 3 barrels seeded + `@agent/index` widened      | **present & stable.** `src/agent/{export,review,templates}/index.ts` all exist; `@agent/index` re-exports `createPlatformAgentDirectories` + `BUNDLED_AGENT_DIRECTORY_NAMES` (`index/index.ts:12-13`). |
| **M-3** `ModelHandler.ts` god-base | 2,068 LoC                                      | **2,069 LoC** (`wc -l`); +1 line, no structural change. Genuinely shared behavior (README's "shared, not duplicated" holds — no per-provider copy-paste).                                              |
| **Provider-type-leak floor**       | 4 provider SDKs on `ModelHandlerContracts`     | **unchanged.** `openai`, `@google/genai`, `@anthropic-ai/sdk`, `@openrouter/sdk` still imported (`ModelHandlerContracts.ts:15-19`).                                                                    |
| **Node flow engine**               | 153 LoC, `BaseNode`/`Flow` only                | **159 LoC** (`src/agent/node/index.ts`); +6 lines, still exactly `BaseNode` + `Flow` (`:31,135`, single `export` `:159`). Matches CLAUDE.md.                                                           |
| **Version**                        | 0.40.4 (short of the v0.41 `runFact.` gate)    | **0.40.4.** Unchanged; retirement not yet due.                                                                                                                                                         |

## 2. Frozen host deep-import width — unchanged at the post-`§7` floor

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package             | `-08-20` | `-08-21` (post-§7) | `d455149` |
| ------------------- | -------- | ------------------ | --------- |
| cli                 | 11       | 8                  | **8**     |
| desktop             | 9        | 6                  | **6**     |
| extension           | 12       | 10                 | **10**    |
| agent (SDK package) | 7        | 7                  | **7**     |

The `-08-21 §7` consolidation (−8 specifiers across the three hosts) holds; this
window's 49 commits since the `-08-21` doc (§6) landed elsewhere, so the counts
stay flat. The set-based ratchet still forbids any new edge and fails on stale
headroom, so the lists can only shrink or hold — the "never widen a baseline"
invariant is structurally enforced. `agent`'s 7 remains near the realistic floor
bounded by the provider-type-leak constraint (§4c).

## 3. Subagent boundaries — still drawn, still mature

Re-confirmed independently by both the core and model-handler audits. The
subagent boundary is a shipped, multi-implementor SPI, not a design task:

- **Contract:** `ChildRunStrategy<TTurn>` + `ChildRunPorts`
  (`src/agent/runtime/childRunLoop.ts`) — a deep module with a narrow turn-based
  interface (`launch` / `runTurn?` / `isTerminal` / `formatDelivery`; upward
  channel just `notify(progress)` + `recordCost(usd)`).
- **Recursion-closing seam:** the `AgentEngine` runtime slot —
  `provideAgentEngine({ executeAgent, resumeToolUseFromResumeData })`
  (`executeAgent.ts:703`), filled at
  `src/tools/delegation/nativeSubagentStrategy.ts:72`. A deliberate load-time
  slot, not a static import, to break the `registry → DelegationTools →
executeAgent → registry` cycle.
- **Launch/output contract:** `SubagentRunOptions` (`executeAgent.ts:303-339`)
  in, `AgentFlowResult` (discriminated `toolUse | workflow`) out.
- **Proof of altitude:** five independent implementors (in-process TeXRA agent,
  workflow-script children, external agent CLIs, background bash) drive through
  the one `childRunLoop`.

The honest six-candidate mapping is unchanged: **reflection and tooluse are the
`agentCategory` dispatch axis inside one run** (`executeAgent.ts` branches on
`setting.agentCategory`), **followUp and goal are substrate**, **review is a
support library behind a tool-use YAML agent**, and **only `agentCreator` is a
genuine "logical agent not yet running as one"** — a single linear
`runAgentCreator` (`src/agent/implementations/agentCreator/agentCreatorFlow.ts`)
that runs inline in the extension host via the `AgentCreatorUI` port, not through
`runAgent`/`ChildRunStrategy`, and is the deepest surviving host deep-import
specifier. Two merges this window (`6295512` fold agent-creator template parsing
into `agentCreatorFlow`; `c864938` relocate its YAML parsing / approval-bypass
policy) **tightened that unit's cohesion** but did not front it behind a door —
so the `agentCreator` boundary remains the open one, correctly, because it
carries interactive-UI design work, not a mechanical move.

## 4. New this pass — concrete, shovel-ready findings the prior green passes did not surface

The three prior passes each reported "no abstraction to remove." This pass's
model-handler audit reached, for the first time, a layer where two removals and a
templated leak-fix are genuinely present. All are behavior-preserving and
independently verified below. §4a and §4b were landed this session at the
maintainer's request (§8); §4c was not (design-gated, see below).

### 4a. `createToolUseFollowUpMessages` — a pure pass-through wrapper on the public port

`ModelHandler.createToolUseFollowUpMessages` (`ModelHandler.ts:1726-1741`) does
nothing but wrap its arguments into a one-element array and delegate:

```ts
return this.createBatchedToolUseFollowUpMessages(
  [{ call, result, attachments }],
  workspaceState,
  text,
  client,
);
```

Its **only production caller** is `ToolUseDispatchNode.ts:615` (the single-result
branch of the batch-vs-single dispatch), which already holds `client`, `call`,
`result`, `attachments`, `workspaceState`, and `text`. **Both** methods are
picked into the port (`IModelHandler.ts:67-68`). Inlining the call site onto
`createBatchedToolUseFollowUpMessages([{ call, result, attachments }], …)`
removes **one port member and one base method** with zero behavior change —
exactly CLAUDE.md's "a wrapper that only … gets inlined" rule, and the first
clearly-removable member the SDK-relevant surface has surfaced across these
passes. **Landed this session (§8)** at the maintainer's request.

### 4b. `createAssistantMessageForPrefillText` — a zero-override internal seam

`ModelHandler.ts:1653-1655` is a `protected` hook that just returns
`this.createAssistantMessage(text)`, with **no overrides anywhere** and only two
in-file callers (`:1549`, `:1613`). Speculative generality; inline to
`this.createAssistantMessage(...)`. Internal only (not on the port), so lower
value than §4a — contrast its sibling `createAssistantMessageForAccumulatedOutput`
(`:1644`), which Anthropic genuinely overrides and correctly stays. **Landed
this session (§8)** alongside §4a.

### 4c. The provider-type leak now has a verified in-tree fix template (`U` → `M`/`T`)

`-08-21 §4.4` named the provider-SDK type leak as the floor on the SDK package's
specifier count but left the mechanism to "manifest-design time." This pass
verified the precise shape **and found the fix already implemented once in-tree**:

- The `IModelHandler` port is parameterized `<M extends ProviderMessage, U =
unknown, T extends SdkToolCall, …>` (`IModelHandler.ts:27-31`).
- **`U` (usage) is already quarantined:** it defaults to `unknown` at the port and
  `RunModelHandler` binds `U = unknown` (`ModelCell.ts:10-15`);
  `extractNormalizedResponse` returns `NormalizedUsage`, and `ProviderUsage.ts`'s
  own header records the win ("Raw usage no longer crosses into core flows"). The
  provider-SDK usage union stays confined to each handler subclass.
- **`M` and `T` still leak.** `M` binds to `ProviderMessage`
  (`src/agent/types/ProviderMessage.ts:15`), a union that imports message types
  from all four provider SDKs (`ProviderMessage.ts:4-8`); `T` binds to
  `SdkToolCall`, whose `raw` members import provider SDK types
  (`ModelHandlerContracts.ts:15-19`). Any Tier-1 export of `IModelHandler` /
  `RunModelHandler` with these defaults would drag all four provider `.d.ts`
  graphs into published declarations.
- **The `U` treatment is directly applicable.** The flow layer treats messages as
  opaque tokens — it only passes `ProviderMessage[]` through handler methods and
  spreads them, never reading message fields — so `M` can be made opaque at the
  port with the concrete union confined to subclasses, exactly as `U` is. `T` is
  load-bearing (`call.raw` is read at `ToolUseDispatchNode.ts:357,366,391,417,477`
  as the `parsedInput ?? call.raw` display fallback), so closing it needs those
  five reads routed through a handler method (or `.raw` typed `unknown`) first —
  a small, bounded refactor, not a blind retype.

This is the highest-value SDK-readiness item in the layer and the one place the
frozen surface is not yet SDK-type-clean. It is a design-gated change (it decides
whether `IModelHandler` can ever be a public export), so it belongs to
manifest-design time — but the template being in-tree makes it concrete, not
speculative.

## 5. Remaining open items (carried forward from `-08-21 §4`, none a defect)

1. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision, not a mechanical cleanup.
2. **Logger + telemetry are process-global singletons with no public plug point.**
   The only log entry point is the frozen deep import `@logger/logUtils`;
   `UsageLogService` is a module singleton with a hardcoded Supabase endpoint. The
   SDK-correct unlock is injectable owners (a `Platform.log` port + a `UsageSink`
   port) behind Tier-1 `configureLogging` / `configureUsage` doors — already
   specified in `docs/prds/2026-05-06-prd-logger-v2.md` and deliberately deferred
   behind the singleton-retirement work. This pass's logger audit adds two small
   sub-items: the **dual public entry surface** (`createLog` vs the free
   `debug/info/warn/error` exports vs `createChannelWriter`) could be narrowed by
   migrating the ~15 free-function importers to `createLog` and demoting the free
   exports to internal, shrinking the `@logger` surface before any freeze; and the
   **stale "protocol-neutral" wording** on `createChannelWriter`
   (`logUtils.ts:157`) is cosmetic debt already noted in the 2026-08-10
   checkpoint. Both low-value; neither a defect.
3. **Two open Tier-1 doors remain** (four of eight landed in `-08-21 §7`):
   fronting `agentCreatorFlow` (its deepest specifier; blocked on the interactive
   `AgentCreatorUI` design, §3), and a `core/state` door (blocked because
   `desktopProgressFileActions.ts` reaches `executionRequests` via a _dynamic_
   `import()` the ratchet counts, so a barrel would leave the leaf live for zero
   ratchet gain — converting it to eager is a load-cost decision, §7b of `-08-21`).
4. **The provider-SDK type leak is the floor on `agent`'s specifier count** — now
   with the concrete `U → M/T` fix template of §4c. A manifest-design decision;
   `scripts/validate-artifacts.mjs` already guards the leak on the built package.
5. **Result-taxonomy documentation.** The core audit flags that an external SDK
   consumer meets three result shapes — `AgentFlowResult` (flow/runtime, discri-
   minated `workflow | toolUse`), `AgentFinalResult` (the stable post-flow
   chaining artifact adding `diffs`/normalized `cost`), and the non-terminal
   `WAITING` state (`executeAgent.ts` `allowWaitingResult` overload pair). The
   transform between them is real (not a delete candidate), but documenting the
   boundary — why `WAITING` exists, why `cost`/`diffs` land only on the final —
   is the single largest "which result do I get?" clarification the surface needs.
6. **`shared-schemas-deep-import`** remains effectively sealed — one documented
   floor entry (`@shared/schemas/log`), `forced`/`gratuitous` both empty.
7. **Publication** remains gated on the named-external-consumer hold — but the
   legal side moved materially this window: the repo was **relicensed under
   Apache-2.0** (`9f50255`), a PocketFlow-TypeScript NOTICE attribution added
   (`619fadd`), and the ToS proprietary claims scoped to the hosted Service
   (`b1ac138`). Packaging/API shape unchanged; the gate is now closer to
   consumer-driven than legal-driven.

## 6. Merges since the `-08-21` pass (`45dbcc8..d455149`, 49 commits)

None add a wrapper layer. Relevant to the audited areas:

- **Tier-1 door consolidation** (`0d2cfb9` seed export/review/templates barrels;
  `c5c5b23` widen `@agent/index`) — the `-08-21 §7` work, present and stable.
- **agent-creator cohesion** (`6295512`, `c864938`) — indirection-reducing;
  tightened the one open subagent-boundary unit without fronting it (§3).
- **model addition** (`f72cda7` DeepSeek Vision via llm-zoo 1.30.0) — new provider
  variant, no wrapper.
- **licensing/publication** (`9f50255` Apache-2.0 relicense; `619fadd` PocketFlow
  NOTICE; `b1ac138` ToS scoping; `0d2934b` open-source readiness audit re-add) —
  §5.7.
- **indirection removal / dedup** (`d55ee6b` derive quota provider from usage
  route; `98483dd` retire delegation API-mode errors; `5b45f96` retire legacy
  LaTeX snapshot controller; `e8b51b0` consolidate six script walkers;
  `6abf0ad` unexport 7 dead view helpers; the multi-batch simplifier sweeps) —
  all neutral or indirection-reducing, consistent with the standing trend.

## 7. Bottom line

Four consecutive passes (`-08-19`, `-08-20`, `-08-21`, `-08-22`) now find a green
top-line verdict, this one re-derived from four fresh independent area audits.
The difference this pass is that the honest answer is no longer "nothing at all
to remove": the model-handler layer carried one pass-through wrapper on the public
port (§4a), one zero-override internal seam (§4b), and the provider-type leak that
gates the SDK package now has a verified in-tree fix template (§4c). The two
mechanical removals were behavior-preserving, independently verified, and — at the
maintainer's request — landed this session (§8), following the same discipline
`-08-21 §7` set: verify first, land only the consensus-mechanical items, leave the
design-gated one recorded. §4c stayed unlanded because it is a manifest-design
decision (whether `IModelHandler` can ever be a public export), not a mechanical
move. The remaining structural work is unchanged and design-gated: the two open
Tier-1 doors, the injectable logger/usage ports, and the manifest decision on
`IModelHandler`. Nothing else found is a defect; nothing else warrants a
speculative edit into the green tree absent a maintainer request.

## 8. Landed refactor — two consensus-mechanical removals (this session)

At the maintainer's request, the two behavior-preserving removals §4a and §4b
named were executed rather than only recorded — both mechanical, both verified
zero-behavior-change, neither touching the design-gated leak question in §4c.

### 8a. Inlined `createToolUseFollowUpMessages` off the public port

**Removed** the pass-through method from `ModelHandler.ts` (was `:1726-1741`)
and its Pick entry from `IModelHandler.ts` (was `:67`). **Re-routed** the one
production call site, `ToolUseDispatchNode.ts:611-625`, onto
`createBatchedToolUseFollowUpMessages` with a single-element `entries` array,
preserving the per-entry `assistantText` (only on `index === 0`) exactly as
before. **Refreshed** the now-inaccurate doc comment on
`createBatchedToolUseFollowUpMessages` (no longer "get the single-call path for
free from `createToolUseFollowUpMessages` below") and the stale reference in
`toolAttachmentUtils.ts:97` (OpenAI Responses' method name).

**Updated** the twelve test call sites that exercised the removed method
directly or mocked it, converting each to the batched shape (single-entry array
in, `(entries, workspaceState, text, client)` argument order):
`GoogleInteractionsLive.vitest.ts`, `GoogleInteractionsToolUse.vitest.ts` (×2),
`ModelHandlerAnthropic.vitest.ts` (×2), `ModelHandlerOpenAIResponse.vitest.ts`,
`ModelHandlerOpenAIToolUse.vitest.ts`, `SessionResumeRetrieval.vitest.ts`,
`ToolUseDispatchParallel.vitest.ts`, `ToolUseDispatchInterruption.vitest.ts`,
`ToolUseRoundFollowUpMedia.vitest.ts`, `BashToolErrorFeedback.vitest.ts`. One
redundant test in `ModelHandlerOpenAIToolUse.vitest.ts` ("single follow-up path
includes the attachment summary") was collapsed into the adjacent batched-path
test it now duplicates, rather than converted — after the removal both exercised
the identical call, so keeping both would have been test-budget churn for no
added coverage (CLAUDE.md "Tests are a budget, not proof of work"). Google's
override does not accept a `client` parameter (`modelHandlerGoogleInteractions.ts:1231-1239`
takes only `entries`/`workspaceState`/`text`), so its three call sites pass three
arguments, not four — caught by `tsc`, not asserted in advance.

### 8b. Inlined `createAssistantMessageForPrefillText`

**Removed** the zero-override `protected` hook (was `ModelHandler.ts:1652-1655`)
and inlined its body at both call sites (`:1549`, `:1613`) to
`this.createAssistantMessage(...)` directly. Internal-only; no port or test
change needed.

### 8c. Validation

`npm run typecheck` — clean across `typecheck:workspace`, `typecheck:test-kernel`,
`typecheck:agent` (the `@texra-ai/agent` SDK build — "Validated 725 declarations
and 70 external packages"), `typecheck:cli`, `typecheck:trace-viewer`,
`typecheck:desktop`. `npm run lint` (eslint) on all fourteen touched files — clean.
`prettier --check` on all fourteen — clean. `npm run check:dead-code-ratchet` —
"no new findings" (430 combined, matching the pre-change baseline exactly — the
removed methods were live, not dead, so the ratchet is unaffected by design).
Full `src/test-kernel/architecture/` suite — 104/104, matching the exact count
`-08-21 §7c` recorded post-landing. The affected model-handler and follow-up test
directories — 934 passed, 4 skipped (no newly-skipped or newly-failing tests).
Net diff: **14 files changed, 96 insertions(+), 113 deletions(-)** — one public
port member removed, one internal method removed, zero behavior change.
