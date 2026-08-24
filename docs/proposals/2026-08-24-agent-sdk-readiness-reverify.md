# Agent-SDK readiness — re-verification pass (2026-08-24)

> **Status:** Written 2026-08-24 against branch HEAD `c08f0fb`
> (`Merge #11338 … session-deep-clean-3`). The scheduled audit routine re-ran the
> standing question — "review the agent core, model handler, logger, and surface
> for unnecessary abstraction and unready surface; design subagent boundaries" —
> against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the four immediately-prior passes
> ([`-08-19`](./2026-08-19-agent-sdk-readiness-reverify.md) at `391033e`,
> [`-08-20`](./2026-08-20-agent-sdk-readiness-reverify.md) at `74fab00`,
> [`-08-21`](./2026-08-21-agent-sdk-readiness-reverify.md) at `c48e5cb`,
> [`-08-22`](./2026-08-22-agent-sdk-readiness-reverify.md) at `d455149`). As in the
> `-08-22` pass, the verdict was re-derived from four fresh, independent area
> audits (core, model handlers, logger, surface + subagents) rather than a diff of
> the prior entry. It reached the **same top-line verdict by an independent route
> — the alignment holds** — over a large window (104 commits since `-08-22`,
> §6), all indirection-neutral or indirection-**reducing**. Unlike every prior
> pass, this one records the frozen host-coupling lists **shrinking, not merely
> holding** (§2), and surfaces — for the first time — the **top structural
> blocker to a clean tools/flows SDK split: the ambient `RunContext`
> `AsyncLocalStorage`** (§4a), a finding none of the five prior passes named.
> **No code was changed this pass** (see §0). Every claim carries a `file:line`,
> config path, or count checked at `c08f0fb`.

## 0. Verdict — and why nothing was landed

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller factories the standing question hunts for
are not present in the audited layers; the two mechanical removals the `-08-22`
pass landed (`createToolUseFollowUpMessages`, `createAssistantMessageForPrefillText`)
**remain removed and re-verified** (§1). The model-handler audit this pass found
**nothing left to remove** in that layer — consistent with `-08-22 §8` having
already cleaned it. The exemplary deep modules (`ModelCell`, `SessionEventHub`,
`PersistedFlow`, `ModelInvocationNode`, `ToolUseFollowUpQueue`) are all things you
would keep if designing from scratch.

**No edit was made this pass, by design.** The `-08-22` removals landed *"at the
maintainer's request"* (its §0, §8). This pass ran unattended on the schedule with
no such request, and the two items it newly surfaces (§4a RunContext ALS, §4b
`AgentEvent` breadth) are **design-gated, not consensus-mechanical** — a
114-site incremental migration and a public-surface-shape decision, respectively.
The discipline `-08-22 §7` set applies unchanged: *"nothing warrants a speculative
edit into the green tree absent a maintainer request."* The deliverable is this
record.

What is new this pass is a sharpening, not a reversal: (a) the frozen host
deep-import lists **shrank** — `@agent/followUp` retired as a host edge from both
desktop and extension (§2); (b) the core audit reached the ambient-identity
carrier that is the real blocker to splitting `src/tools` + the flows into an
independently-embeddable unit (§4a); and (c) the surface audit isolated the one
genuine internal-breadth leak on the public surface — `AgentEvent` re-exporting
the full 21-member internal trace union (§4b).

## 1. Every `-08-22` tracked fact re-verifies at `c08f0fb`

| Item | `-08-22` state (`d455149`) | `c08f0fb` state |
| --- | --- | --- |
| **§4a/§4b removals** | landed; `createToolUseFollowUpMessages` + `createAssistantMessageForPrefillText` inlined | **still removed.** `grep` for both names across `src/` returns nothing — neither method nor its port entry has regrown. |
| **L-3** (dead redaction branch) | closed; `redactSecrets` single-arg | **still closed.** `export function redactSecrets(text: string): string` (`src/logger/redaction.ts:81`). |
| **L-2** (process-global log sink) | module-singleton, deliberate; no platform port | **unchanged.** `logUtils.ts` **256 LoC** (identical to `-08-22`); no `platform().log` port. |
| **§7 Tier-1 doors** | 3 barrels seeded (`export`/`review`/`templates`) | **present & stable.** All three `src/agent/{export,review,templates}/index.ts` exist. |
| **M-3** `ModelHandler.ts` god-base | 2,069 LoC | **2,043 LoC** (`wc -l`); −26, consistent with the `-08-22 §8` two-method removal. Model-handler audit this pass: **not** a god-class — streaming/usage/pricing/media/errors already extracted into `support/` collaborators; no per-provider copy-paste. |
| **Provider-type-leak floor** | 4 provider SDKs on `ModelHandlerContracts` | **unchanged.** `openai`, `@google/genai`, `@anthropic-ai/sdk`, `@openrouter/sdk` still imported (`ModelHandlerContracts.ts:15-19`; `ProviderMessage.ts:4-8`). Guard active: `validate-artifacts.mjs:112` throws on any provider type reachable from the main entry. |
| **Node flow engine** | 159 LoC, `BaseNode`/`Flow` only | **159 LoC** (`src/agent/node/index.ts`), unchanged. Both flows build graphs directly in their `create*Flow()` factories; no shared-machinery collapse available (§3). |
| **Version** | 0.40.4 | **0.40.5** (`9469d97`). Still short of any `runFact.`/v0.41 retirement gate. |

## 2. Frozen host deep-import width — **shrank** this window

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*` deep-import
specifiers per package, past the `@agent` barrel):

| Package | `-08-21` | `-08-22` | **`c08f0fb`** | Δ this window |
| --- | --- | --- | --- | --- |
| cli | 8 | 8 | **8** | — |
| desktop | 6 | 6 | **5** | **−1** |
| extension | 10 | 10 | **9** | **−1** |
| agent (SDK package) | 7 | 7 | **7** | — |

The two dropped edges are the **same specifier**: `@agent/followUp` was retired
as a host deep-import from both desktop and extension, leaving **cli its only host
consumer**. This tracks the followUp-collapse commits in the window (`8168906`
delete continuation generation fencing; `373f0d9` three submission outcomes;
`a5ce726` five-kind `FollowUpSubmission`, no `QueueEntry.lifecycle`). The
set-based ratchet forbids any new edge *and* fails on stale headroom, so the lists
can only shrink or hold — this is the first pass to record an actual shrink rather
than a flat hold, and it came from real refactoring, not dead-line deletion.
`agent`'s 7 remains at the floor bounded by the provider-type-leak constraint (§4c).

## 3. Subagent boundaries — still drawn, still mature; three units now confirmed clean

Re-confirmed independently by the core audit. The subagent boundary is a shipped,
multi-implementor SPI (`ChildRunStrategy<TTurn>` + `ChildRunPorts`,
`src/agent/runtime/childRunLoop.ts`), driven by five independent implementors
through one loop — unchanged from `-08-22 §3`. The `AgentEngine` runtime slot
(`provideAgentEngine`, `executeAgent.ts`) still breaks the `registry →
DelegationTools → executeAgent → registry` cycle at load time.

The six-candidate mapping is unchanged, and this pass adds file-anchored
confirmation that the "not-yet-a-subagent" units are already cleanly contracted:

- **`agentCreator`** — the one genuine "logical agent not yet running as one," and
  the **reference model** for a clean boundary: `runAgentCreator`
  (`implementations/agentCreator/agentCreatorFlow.ts`) is one linear async function
  behind a single injected `AgentCreatorUI` port, with **no `SessionHandle`, no
  shared store, no `RunContext`/ALS, no `PersistedFlow`**. It needs nothing to
  split *except* the interactive-UI design that keeps it fronted as a host deep
  import (extension's deepest specifier). The open door here is correctly open —
  it carries design work, not a mechanical move.
- **`review`** — pure functions (`collectReviewDiff`, `createReviewIssue`,
  `buildReviewInstruction`), no session/store coupling; its `index.ts` is a frozen
  ratchet-tracked door, not indirection.
- **`workflowScript`** — already runs agent runs through an **injected**
  `WorkflowAgentRunner` port rather than importing `runAgent`, i.e. the injection
  seam an SDK split needs is already present.
- **`goal`** — `maybeBuildGoalContinuation` is pure over a `streamId`, coupling
  only to the `GoalStore` singleton + `isGoalEnabled()`, not to `SessionHandle`.

`IToolUseSession` (`core/flows/IToolUseSession.ts`) has a single implementer but is
**load-bearing** — it enforces the `core → followUp` dependency direction — and
correctly stays.

## 4. New this pass — the structural blocker the prior five passes did not reach

The prior passes audited the flow layer and the model-handler wrappers. This pass's
core audit went one layer down, to how **tools** obtain run identity, and found the
real gate on an SDK-embeddable `src/tools` + flows.

### 4a. Ambient `RunContext` `AsyncLocalStorage` — the top tools/flows split blocker

`src/agent/runtime/RunContext.ts:78` defines
`const runContextScope = new AsyncLocalStorage<RunContext>()`; it is read through
`getRunContext*` at **~107 call sites across ~89 files** (`grep`), concentrated in
`src/tools/**`. The **flows themselves already run off the injected
`RunScope`/`AgentCore` services bag** — `RunContext` survives only so **tools** can
read run identity (`streamId`, `executionId`, `session`, `model`, tool policy)
ambiently, duplicating data already on `RunScope`.

This is **not load-bearing for correctness** — it is a convenience read-channel —
and the migration away from it is already the documented intent:
`src/agent/core/flows/BaseFlowServices.ts:22-24` states that injecting these as an
explicit frozen service field "lets the cycle flows run without an
`AsyncLocalStorage` frame — the property an SDK embedder wants." So long as tools
resolve identity ambiently, a subagent/worker cannot be split cleanly without
dragging the ALS frame along. Closing it (pass an explicit tool-context /
`RunScope` into each tool) is **the single contract** that makes `src/tools` and
the flows independently embeddable — and it collapses the six near-identical
`getRunContext{Interactions,StreamId,…}` accessors plus the `bare`/`launch`
discriminated union (`RunContext.ts:22-46,177-226`), which are drift-machinery
that exist *only* because reads go through the ambient store.

**Effort: large, incremental (tool-by-tool).** Design-gated, not mechanical — this
is the north-star's "make the flow substrate ALS-free" work, now with a concrete
114-site scope and a documented target shape. Not landed (see §0).

### 4b. Public `AgentEvent` re-exports the full 21-member internal trace union

`packages/agent/src/index.ts:40` re-exports `AgentEvent` from `@agent/trace`
(`src/agent/trace/events.ts`), which is the **entire internal run vocabulary**
(`LogEvent`, `StageStartEvent`, `DomainEvent`, … 21 members), not a curated
streaming subset. This is the one genuine internal-breadth leak on the public
surface (it is not a *provider*-type leak — the `validate-artifacts.mjs` guard
still passes). `docs/prds/2026-06-29-prd-agent-sdk-boundary.md` already proposes
splitting this into a Tier-1 streaming `RuntimeEventPayloads` vs Tier-2. This is
*the* substantive surface-shape gap and the natural first entry of the owed Tier-1
manifest (§5.2). **Design-gated; not landed.**

### 4c. `IModelHandler` is not the Tier-1 manifest — don't conflate

The model-handler audit re-measured the port: `IModelHandler` (`IModelHandler.ts:33-77`)
`Pick`s **45 of ~54** public/abstract members of `ModelHandler` — ~83% of the class.
Its `Pick`-alone construction is a real, cheap **drift-prevention** benefit and it
is correctly used as an internal generic seam (`ModelCell.ts`, `followUpMessages.ts`).
The finding is a *"don't conflate"* note, not a change: when the Tier-1 manifest is
authored, `IModelHandler` should **not** be mistaken for it — a curated SDK surface
is smaller and hand-listed (an interface the class `implements`), not a near-total
`Pick` off a churning 2,043-line base. **No change now.**

### 4d. Provider-type leak — floor unchanged, `U → M/T` fix template still stands

`-08-22 §4c`'s template is unchanged and re-verified: `U` (usage) is already
quarantined at the port (`ModelCell.ts` binds `U = unknown`); `M`
(`ProviderMessage`) and `T` (`SdkToolCall`) still import all four provider SDKs and
are the floor on the SDK package's specifier count. Still a manifest-design
decision, still guarded on the built package by `validate-artifacts.mjs`. Not
landed.

## 5. Remaining open items (carried forward, none a defect)

1. **`HostInteractions` required/optional (north-star TD-2a)** — open maintainer
   contract decision, not a mechanical cleanup. Unchanged.
2. **Tier-1 public manifest does not exist yet.** The enforcing freeze ratchet
   exists; a *declared* public manifest does not. First-cut (~11 symbols from what
   `index.ts`/`node.ts`/`schemas.ts` already export): `runAgent`, `AgentRun`,
   `RunAgentInput` + `HostInteractions`, a **narrowed** `AgentEvent` (§4b),
   `AgentFlowResult` (+ `ToolUseFlowResult`/`WorkflowFlowResult`), `defineTool` +
   `ITool`, `nodePlatform` + `NodePlatformOptions`, `AgentConfigSchema` +
   `AgentConfig`. Medium effort; the stated open work.
3. **Logger + telemetry are process-global singletons with no public plug point.**
   Unchanged. The SDK-correct unlock is injectable owners (`Platform.log` port +
   `UsageSink` port) behind Tier-1 `configureLogging`/`configureUsage` doors,
   specified in `docs/prds/2026-05-06-prd-logger-v2.md`, deferred behind
   singleton-retirement. The two low-value sub-items (`-08-22 §5.2`) stand: the
   dual public entry surface (`createLog` vs free `debug/info/warn/error` vs
   `createChannelWriter`) could be narrowed to `createLog`-only before any freeze;
   the stale "protocol-neutral" wording on `createChannelWriter`
   (`logUtils.ts:157`) is cosmetic. Neither a defect.
4. **Two open Tier-1 doors remain** (four of eight landed in `-08-21 §7`):
   fronting `agentCreatorFlow` (extension's deepest specifier, §3; blocked on the
   interactive `AgentCreatorUI` design), and a `core/state` door (the
   `executionRequests` reach appears in all three product hosts; blocked because
   `desktopProgressFileActions.ts` reaches it via a *dynamic* `import()` the ratchet
   counts, so a barrel would leave the leaf live for zero ratchet gain).
5. **Result-taxonomy documentation** (`-08-22 §5.5`) — an external consumer meets
   `AgentFlowResult`, `AgentFinalResult`, and the non-terminal `WAITING` state; the
   transform is real, but documenting *which result you get and why* is the single
   largest surface clarification owed. Unchanged.
6. **`shared-schemas-deep-import`** remains sealed — one documented floor entry
   (`@shared/schemas/log`), `forced`/`gratuitous` both empty.
7. **Publication** remains gated on the named-external-consumer hold; the legal
   side already moved (`-08-22 §5.7`: Apache-2.0 relicense, PocketFlow NOTICE, ToS
   scoping). Packaging/API shape unchanged.

## 6. Merges since the `-08-22` pass (`d455149..c08f0fb`, 104 commits)

None add a wrapper layer; the window is dominated by **indirection-reducing**
runtime/session/storage cleanup. Relevant to the audited areas:

- **Session/runtime deep-clean** (three merged branches `session-deep-clean`,
  `-2`, `-3`; `per-execution-queue`; the lease refactors `a7b1a04`/`38e515d`) —
  collapsed run-outcome projection tables into single switches (`434d004`,
  `fccf82f`), unified child-run outcome/resume/finalize paths (`37f43eb`,
  `efc62c0`, `49e3a9f`), dropped a model-facing subscribe capability (`b01692b`)
  and a single-consumer child-activation fan-out (`cc42a20`), and collapsed the
  waiting-termination recovery ladder (`95e30ed`). All net-negative on structure.
- **followUp collapse** (`8168906`, `373f0d9`, `a5ce726`) — the source of the §2
  frozen-list shrink; retired `@agent/followUp` as a host edge from desktop and
  extension.
- **Healthy backout** (`c32e515` reverts `10f4a74` "fold interaction ownership
  into the execution registry") — a refactor tried and reverted same-day rather
  than forced through: the "verify, and don't force a change that doesn't pan out"
  discipline in action, not drift.
- **Discriminated-union tightening** (`ac097d8` LaTeXdiffResult; `72f8a6e`
  ResumabilityDecision; `9d7ac46`/`492dfbd` type YAML inheritance cast-free) and
  **CLI config derivation** (`372ba28`, `4e311a7`, `d61bd56`) — all
  indirection-reducing.
- **Version** `9469d97` bump to 0.40.5; changelog finalize `12edacb`.

## 7. Bottom line

Five consecutive passes (`-08-19` … `-08-24`) now find a green top-line verdict,
this one re-derived from four fresh independent area audits over a large
(104-commit) indirection-reducing window. Two things are new and both sharpen
rather than reverse the verdict: the frozen host-coupling lists **shrank for the
first time** (`@agent/followUp` retired from two hosts, §2), and the core audit
named the **real structural blocker** to an SDK-embeddable tools/flows split — the
ambient `RunContext` `AsyncLocalStorage` (§4a) — which no prior pass had reached.
The model-handler layer, cleaned by `-08-22 §8`, now has **nothing left to remove**.
The remaining work is unchanged and design-gated: the Tier-1 manifest (with a
narrowed `AgentEvent` as its first entry, §4b), the RunContext ALS migration, the
injectable logger/usage ports, the two open doors, and the `IModelHandler`/leak
manifest decision. **Nothing found is a defect, and — this being an unattended
scheduled run with no maintainer request — nothing was edited into the green tree
(§0).** The record is the deliverable.
