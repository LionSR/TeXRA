---
created: 2026-08-13
---

# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-13 at HEAD `026a192` from a fresh
> read-only pass over the four named areas (agent core, model handlers,
> logger/trace, package surface), every moving claim re-measured against the
> live tree and `config/ratchets/`. This is a _current-state_ re-measurement,
> not a new plan. It continues the near-daily checkpoint series — read alongside
> the immediately prior re-verify
> [`../../proposals/2026-08-12-agent-sdk-readiness-reverify.md`](../../proposals/2026-08-12-agent-sdk-readiness-reverify.md)
> and the base audit
> [`2026-08-10-agent-sdk-readiness-checkpoint.md`](./2026-08-10-agent-sdk-readiness-checkpoint.md),
> under the plan of record
> [`../../proposals/2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Its job is to confirm whether the standing conclusions still hold and to
> record what has landed since the 2026-08-12 pass. This routine made **no code
> changes**.

## 0. Verdict

**Unchanged and now materially advanced.** Agent core, model handlers,
logger/trace, and the package surface remain aligned with the Agent-SDK shape;
no genuinely redundant abstraction was found to remove, and no structural
refactor is warranted. The change worth recording is that the north-star's
**Tier-1 barrel fold-in has moved from "planned" to "underway"**: the first
increment landed in `#10011` after the 2026-08-12 note was written, and it is
holding cleanly at this HEAD.

The 2026-08-12 re-verify closed on "the barrel is untouched since -08-04, so the
§3-cluster fold-in has not started _in the barrel_" and left the incremental
Tier-1 fold-in as its item 1 (human-review-gated). That item has now had its
first landing.

## 1. What landed since 2026-08-12 — first Tier-1 barrel fold-in (`#10011`)

`refactor(agent): fold host runtime deep-imports behind an @agent/runtime
barrel` (commit `d3e6ad5`) added `src/agent/runtime/index.ts` — a curated public
surface following the same pattern as `@agent/trace` and `@agent/storage` — and
migrated every host runtime deep-import onto it.

Re-verified at this HEAD:

- The barrel exists (`src/agent/runtime/index.ts`, 116 LoC, ~55 exported
  symbols, value/type split).
- **Hosts no longer deep-import `@agent/runtime`.** A scan of
  `packages/{cli,desktop,extension}/src` finds **0** `@agent/runtime/<sub>`
  specifiers and **56** imports through the single `@agent/runtime` door.
- No import cycle: nothing inside `src/agent` imports the barrel.

## 2. Baseline re-measurement (moving numbers, at `026a192`)

Distinct `@agent/*` deep-import specifiers per package
(`config/ratchets/host-agent-import-baseline.json`, last set by `#10011`):

| Package     | Prior (pre-`#10011`) | HEAD `026a192` | Direction |
| ----------- | -------------------- | -------------- | --------- |
| extension   | 34                   | **17**         | ↓ −17     |
| cli         | 31                   | **19**         | ↓ −12     |
| desktop     | 25                   | **13**         | ↓ −12     |
| agent (SDK) | 10                   | **10**         | held      |

Movement is entirely downward — the north-star invariant (_shrink, never widen_)
is intact, and the host width has dropped by roughly a third in a single
increment. The SDK package's own list holds at 10 by design (see §3).

## 3. Next concrete shrink target — sharpened by `#10011`

The barrel `#10011` added seals the **hosts**, but the SDK package
(`packages/agent/src`) itself does **not** yet route through it. Its 10
`@agent/*` specifiers, re-measured directly, are:

```
@agent/core/definition/AgentConfig      @agent/runtime/AgentFlowResult
@agent/core/definition/AgentDataclass   @agent/runtime/ExecutionHandle
@agent/core/tools/ToolTypes             @agent/runtime/HostInteractions
@agent/index/agentRegistry              @agent/runtime/SessionHandle
@agent/trace                            @agent/runtime/runAgent
```

Five are genuine public contract already re-exported through the barrel
(`AgentConfig`, `AgentDataclass`, `ToolTypes`, `AgentFlowResult`, `@agent/trace`).
The other five are runtime wiring reached only inside the `runAgent` wrapper body
(`packages/agent/src/index.ts:2-12`) — and four of them
(`ExecutionHandle`, `HostInteractions`, `SessionHandle`, `runAgent`) are now
_exactly the modules the new `@agent/runtime` barrel already re-exports_. The
SDK package is currently the one consumer still bypassing that door.

This makes the north-star's §2 target more concrete than before: give the
runtime one higher-level, public-typed entry that resolves the agent by name,
owns the session, and returns/accepts only public types, then route the SDK
package's own five runtime deep-imports through it (or, minimally, through the
new barrel). That seals the SDK package's own 10-wide seam and is the natural
second increment after `#10011`. It remains human-review-gated — a public-API
decision, not an unattended mechanical edit.

## 4. Abstraction audit — still nothing redundant to remove

Spot-re-verified against the repo's own guardrails; the standing conclusions of
the `-05-29 → -08-12` chain reproduce:

- **`runAgent` is not a pass-through.** It still assigns `executionId`
  (`runAgent.ts:103`), calls `registerExecution` (`:121`), and holds the
  execution lease before `executeAgent` — distinct launch semantics, earned
  layering.
- **The SDK barrel still mirrors the Anthropic `Query` pattern** and redeclares
  its own minimal `HostInteractions` as genuine boundary translation
  (`packages/agent/src/index.ts:4-10`), not a removable alias.
- **`ModelHandler`, the model-factory routing round-trip, and
  `applyHelperModelPreference`** remain the load-bearing, watch-don't-rewrite
  items last catalogued in the 2026-08-12 §3 — no new redundancy, no unmerged
  parallel code.
- **Subagent boundaries unchanged:** the `delegate_agent`/`delegate_workflow` →
  `executeSubagent` → `ChildRunStrategy` seams are already the boundaries; no new
  split to design.

## 5. Carry-forward open items (all pre-existing; none performed by this routine)

1. **Seal the SDK package's own runtime seam** (§3) — the natural next increment
   after `#10011`. Human-review-gated.
2. **Stabilize the withheld interaction contract**
   (`packages/agent/src/index.ts`, hard-deny `requestRetry`) — the next surface
   decision, unchanged.
3. **Decide the logger→stream question** — bootstrap/routing logs still reach
   only the process-wide static sink, not the per-run `AgentRun` `AgentEvent`
   stream; small and additive, belongs to the Tier-1 surface decision. Unchanged
   from the 2026-08-12 §4.
4. **PT-2 `SessionHandle.useHostInteractions` per-concern pass-through** — still
   present, still tracked, worth clearing before the SDK surface is frozen.

## 6. Bottom line

The four named areas remain converged on the Agent-SDK shape; the guardrails are
holding and have _tightened sharply_ since the last pass (host deep-import width
down ~⅓ via `#10011`). There is no unnecessary abstraction to remove and no new
subagent boundary to design. The open work is the same packaging track — now with
its first fold-in landed and the SDK package's own 10-wide seam as the clearly
lit next target.

---

_Method: single read-only pass over the four named areas, moving claims
re-measured against the live tree and `config/ratchets/` at HEAD `026a192`
(deep-import scan of `packages/{cli,desktop,extension,agent}/src`, barrel
inspection, launch-layering spot-check), and reconciled against the 2026-08-12
re-verify and the `#10011` commit message via `git`. Dependencies were not
installed in this ephemeral clone, so the vitest ratchet was verified by direct
specifier scan rather than by running the suite. No production code was
modified._
