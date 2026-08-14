# Agent-SDK readiness — scheduled re-verification pass (2026-08-14)

> **Status:** Verification / reconciliation, written 2026-08-14 at HEAD `70df50f`.
> This is **not** a new plan. A scheduled audit routine re-ran the standing
> question — "audit the core, model handler, logger, and surface for unnecessary
> abstraction and unready surface" — against the current tree and reconciled the
> answer with the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md))
> and the two prior verification passes
> ([`2026-08-04-agent-sdk-readiness-review.md`](./2026-08-04-agent-sdk-readiness-review.md),
> [`2026-08-12-agent-sdk-readiness-reverify.md`](./2026-08-12-agent-sdk-readiness-reverify.md)).
> Every claim carries a `file:line` or config path, checked at this HEAD. No code
> was changed by this routine.

## 0. Verdict

**The standing verdict still holds: the codebase is already well-aligned with an
Agent-SDK shape. No structural refactor is warranted, and no genuinely redundant
abstraction was found to remove.** The one structural open item (§3) is the
human-review-gated Tier-1 public-API decision, not an unattended mechanical edit,
so this routine performed **no code changes**.

Two things are worth recording since `-08-12`:

1. **The host deep-import baselines are materially smaller than the last recorded
   pass** (§2). Whichever way the history reconciles, at this HEAD the surface is
   tighter and the invariant CLAUDE.md pins — _never widen a baseline_ — holds.
2. **The SDK package's own coupling width is unchanged at 10 specifiers, with the
   identical 5-public + 5-incidental split** (§2). The concrete Tier-1 fold-in
   target has therefore **not** advanced in the barrel — it is exactly where
   `-08-12 §2` left it.

---

## 1. Scope re-audited

| Area          | Entry points inspected                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent core    | `src/agent/runtime/{runAgent,executeAgent}.ts`, `src/agent/implementations/flows/`                                  |
| Model handler | `src/agent/modelHandlers/ModelHandler.ts`, `src/agent/types/IModelHandler.ts`                                       |
| Logger        | `src/logger/{logUtils,redaction}.ts`, `src/agent/trace/channelTrace.ts`                                             |
| Surface       | `packages/agent/src/{index,schemas,node}.ts`, `config/ratchets/host-agent-import-baseline.json`, the R-b ratchet    |
| Subagents     | `src/tools/delegation/`, `src/agent/{review,goal,roster}/`, `implementations/flows/agentCreator/`                   |

## 2. Surface — invariant holds; the fold-in target is unchanged

Distinct `@agent/*` deep-import specifiers per package
(`config/ratchets/host-agent-import-baseline.json`, verified against a scan of
each package's `src` tree):

| Package     | `-08-12` (recorded) | `-08-14` baseline | scan at HEAD | invariant |
| ----------- | ------------------- | ----------------- | ------------ | --------- |
| extension   | 34                  | **17**            | ≤ 17         | held      |
| cli         | 31                  | **18**            | ≤ 18         | held      |
| desktop     | 25                  | **13**            | ≤ 13         | held      |
| agent (SDK) | 10                  | **10**            | 10           | held      |

The scan at HEAD sits at or below the checked-in baseline for every package —
nothing widened, which is the only thing the R-b ratchet
(`src/test-kernel/architecture/hostAgentDeepImportRatchet.vitest.ts:154-161`)
guards. The host counts are much lower than the numbers the `-08-12` note
recorded; this branch's history is shallow here and does not contain that pass's
cited HEAD, so I record the current authoritative numbers rather than assert a
delta I cannot fully trace. Either way the direction is correct and the invariant
holds. **One reconciliation item for a maintainer:** confirm the host-list shrink
reflects landed Tier-1 fold-in versus a branch-history gap; it does not block
anything.

The **SDK package's own 10 specifiers** decompose exactly as `-08-12 §2` found:

- **5 genuine public re-exports** — `@agent/core/definition/AgentConfig` and
  `@agent/core/definition/AgentDataclass` (schemas + types,
  `packages/agent/src/schemas.ts:1-24`), `@agent/core/tools/ToolTypes`
  (`index.ts:24-25`), `@agent/runtime/AgentFlowResult` (`schemas.ts:25-33`,
  `index.ts:29-33`), and `@agent/trace` (`index.ts:23`).
- **5 incidental internal wiring** reached only inside the `runAgent` wrapper
  body — `@agent/index/agentRegistry` (`index.ts:10`),
  `@agent/runtime/runAgent` (`:12`), `@agent/runtime/SessionHandle` (`:11`), and
  the type-only `@agent/runtime/ExecutionHandle` (`:3`) and
  `@agent/runtime/HostInteractions` (`:5`).

Sealing those five behind one higher-level, public-typed runtime entry (resolve
agent by name, own the session, accept/return only public types) is the concrete
shrink target — **unchanged since `-08-12`**, because the barrel
(`packages/agent/src/index.ts`) is structurally the same: a single
`runAgent(input): AgentRun` (`:206`), `HostInteractions` that still withholds
approval methods pending a stable contract (`:42-50`), a hard-deny `requestRetry`
(`:236-239`), and package-owned child teardown (`:282-297`).

## 3. Abstraction audit — still nothing redundant to remove

Every layer a generic "collapse the wrappers" pass would flag was re-checked
against the repo's own guardrails and remains load-bearing:

- **Runtime layering `runAgent` → `executeAgent` is earned.** `runAgent`
  (`runAgent.ts:78-85`) validates-then-runs: assigns an `executionId` when the
  request omits one, registers the execution, and invokes `openWorkflowOutput` —
  not a pass-through. `executeAgent` has ≥3 distinct production entries
  (`runAgent.ts:157`, subagent delegation `nativeSubagentStrategy.ts:254`, and the
  CLI resume path), so the split carries real reuse.
- **`ModelHandler` remains a genuine provider port.** `IModelHandler`
  (`src/agent/types/IModelHandler.ts`) is the narrowed consumer port and still
  carries the single interface-only optional member the class does not require of
  every path — `createBatchedToolUseFollowUpMessages` (`:104`) — feature-detected
  at the call site. Not redundant.
- **The logger surface is already minimal** and single-owner: `logUtils.ts`
  (250 LoC) is the sink/redaction layer, `redaction.ts` (117 LoC) the policy, and
  `channelTrace.ts` (82 LoC) spreads `noopTrace` and overrides only the log
  methods — no wrapper subclass. Nothing to remove.
- **Standing watch-items, unchanged, do not touch:** the `applyHelperModelPreference`
  single-caller extraction (real capability branching + its own vitest) and the
  `ModelFactory` routing round-trip that re-reads `PROVIDER_HANDLER_ROUTES`
  (documented rationale; async provider overrides can't live in the pure
  predicate). Both remain defensible-but-not-free — revisit only if edited for
  another reason.

## 4. Logger observability gap — carried forward from `-08-12 §4`

No change. Anything logged outside a live run's `AgentTrace` still never reaches
the SDK embedder's `AgentRun` stream: the package's own bootstrap logger
(`createChannelTrace('agentPackage')`, `index.ts:75`) and model-handler routing
decisions log to the process-wide sink, not the per-run `AgentEvent` stream.
Whether those should join the stream is a Tier-1 surface decision, not a defect to
hot-fix. (`platform().log` is still not a real surface — do not plan against it.)

## 5. Subagent boundaries — unchanged from `-08-04 §4` / `-08-12 §5`

The dispatch boundary (`delegate_agent`/`delegate_workflow` → `executeSubagent` →
`createNativeSubagentStrategy` → `startChildRunLoop`) is still cleanly drawn and
host-agnostic. Already-independent units to promote as-is: `src/tools/delegation/`,
`src/agent/review/` (review→fix pipeline), `agentCreator/agentCreatorFlow.ts`, the
agent-CLI adapters. The two per-run engines (`runReflectionFlow`, `runToolUseFlow`)
and the `goal/` loop remain runtime-coupled; isolating them behind the barrel _is_
the §2 Tier-1 work, not a separate refactor.

## 6. Actionable items (all pre-existing; none performed by this routine)

1. **Tier-1 barrel, incrementally** (north-star; §2). Fold the five incidental
   wiring specifiers into one higher-level public entry, one cluster per PR, and
   shrink the matching baseline. Human-review gated.
2. **Stabilize the withheld interaction contract** (`index.ts:42-50`, hard-deny
   `requestRetry` `:236-239`). The next surface decision.
3. **Decide the logger→stream question** (§4). Small, additive; belongs to the
   Tier-1 surface decision, not a standalone churn PR.
4. **Reconcile the host baseline numbers** (§2). Confirm the drop from the
   `-08-12` record is landed fold-in versus a history gap. Bookkeeping, not a code
   change.

Nothing here is a defect. Items 1–3 are the already-planned north-star work with
current line references; item 4 is this pass's only fresh, non-code note.
