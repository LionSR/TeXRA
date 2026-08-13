# Agent SDK Readiness — Verification Checkpoint (2026-06-25)

> **Packaging note (2026-07-05):** #7099 later demotes/deletes the unused
> `@texra/core` package. Mentions below are historical checkpoint observations,
> not current workspace layout.

**Status:** Verification checkpoint, not a new audit. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md) and its most recent addendum
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md).
This pass re-verified the standing audit against the working tree at HEAD
(`b2dcd42`) and records **only** drift since the 2026-06-24 delta — it does not
re-audit or re-litigate adjudicated findings.

## Why this exists

A fresh "review and refactor for Agent SDK readiness" request was scoped against
the same four areas the canonical audit already covers (agent core + runtime,
`modelHandlers/`, logger/trace, public surface). Rather than re-run an audit that
the proposals explicitly warn will re-surface already-rejected traps
(`IModelHandler` "duplicate", OpenRouter/OpenAI merge, cycle-wrapper inlining,
god-file mechanical split), this checkpoint confirms the existing findings are
still accurate at HEAD and notes that the recommendations are **actively
landing**.

## Update (2026-06-25, applied) — the two open core cleanups landed

A follow-up "check deeper and refactor" pass applied the two genuinely-safe,
deliberately-deferred core cleanups from the 2026-06-24 delta. **These two
changes are introduced by this PR (#6620), not present at `b2dcd42`** — that SHA
is the pre-refactor base the rest of this checkpoint verifies against, so a
reader cross-referencing it will find the P3a/P3b diff in this PR's commit, not
at `b2dcd42`. Both are behavior-neutral and verified (typecheck ×4 ✓, eslint ✓,
649 agent tests ✓):

1. **Delta P3a — empty-type flow-param aliases removed.** Deleted the
   `export type { FlowParams as ToolUseFlowParams }` / `… as ReflectionFlowParams`
   re-export shims (`ToolUseServices.ts`, `ReflectionServices.ts`) and repointed
   the 8 node generic slots directly at `FlowParams` from
   `@agent/core/flows/BaseFlowServices`. Removes an anti-shim rename re-export the
   repo convention flags; no distinct type information was lost (both aliased
   `Record<string, unknown>`).
2. **Delta P3b — `withModelClient` closure DRY, done the safe way.** The delta
   deferred this because the obvious extraction (spread the helper's _result_ into
   `setServices`) eagerly evaluates the `client` getter and **breaks the relay-401
   live-rebinding**. The landed helper avoids that: `withModelClient(base,
modelHandler)` defines the `client` getter + `refreshClient` on its **returned
   literal**, and both call sites (`ResponseCycleNode`, `ToolUseCycleNode`) pass
   the result straight to `flow.setServices(...)` — never spreading it — so the
   getter stays live (the getter and `refreshClient` close over the same `client`
   binding, exactly as the two former inline copies did). One home for the closure
   instead of two; the `Node.exec → createFlow → flow.run` shape is untouched.

The rest of this checkpoint is the original 2026-06-25 verification; the
"genuinely open" list below now excludes the two items above.

## Verdict — unchanged

**The codebase remains well-aligned and is converging on the plan.** The
SDK-idiomatic spine is intact and confirmed in-tree: the PocketFlow
`Node.exec → createFlow().run` shape, the `AgentTrace` emit/subscribe channel,
the `platform()` composition root, the `createModelHandler` factory, and the
lead-and-specialists delegation model. This is not a codebase drowning in
needless abstraction; the live work is **surface curation and per-session state
relocation**, exactly as the canonical plan sequences it.

## Verified at HEAD (`b2dcd42`, 2026-06-25)

| Audit claim                                             | Tree state                                                           | Result  |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| Step 5 — `@texra/core` populated (not the 1-line stub)  | `packages/core/src/index.ts` = 134 LOC curated surface               | ✓       |
| Step 1 — dead `getDefaultAgentRuntimeHost` singleton    | grep: zero hits in `src/`                                            | ✓       |
| Delta P2b — dead `WorkspaceProvider.watch` port removed | `src/platform/interfaces/workspace.ts`: no `watch`                   | ✓       |
| Delta P1 — finalize-callback guard                      | `ResponseCycleFlow.ts:455-461` wraps `onRoundFinalized` in try/catch | ✓       |
| Delta P3a — empty-type flow-param aliases               | removed; 8 nodes use `FlowParams` directly (see Update above)        | this PR |
| Delta P3b — `withModelClient` closure duplication       | extracted to `CycleServices.withModelClient` (liveness-safe)         | this PR |

No drift in the `b2dcd42` rows: everything the audit marked LANDED is present;
everything it marked deferred is still deferred. The last two rows (P3a/P3b) are
not at `b2dcd42` — they are the changes this PR introduces (see Update above).

## Recommendations landing since 2026-06-24

The plan is being executed, not just documented. Commits since the delta audit:

- **`6cc6b20`** `refactor(agent,platform): harden round finalization; drop dead
workspace.watch port` — lands delta-audit **P1** + **P2b** verbatim.
- **`d32be3b`** + **`a15dd86`** `refactor/fix(executeAgent): extract per-category
flow runners from routing lambda` — lands the canonical proposal's
  **"cleanest internal seam"** subagent recommendation: stop threading the
  14-field launch context by spread; key each agent category to an explicit,
  typed per-flow runner. This is the structural pre-work for config-selected
  subagent delegates.
- **`0e97b51`** `refactor: tighten two abstraction-layer boundaries`.
- **`c17f4ce`** `refactor: dedupe model-handler prefill and guard core settings
paths`.
- **`bd3b4b9`** `docs: reconcile stale Recommendation with second-pass Update`.

## What remains genuinely open (all deliberately deferred — do NOT apply unattended)

After the 2026-06-25 Update above (P3a + P3b landed), these are the only open
items, and the canonical/delta audits deferred each on purpose. Neither is a
quick win.

1. **Cross-provider user-message / media-block scaffold** (~150–250 LOC skeleton
   across the four handler families): real, but a tracked design item — the
   four-shape provider abstraction is justified and must survive. (delta "Track")
2. **Surface / multi-tenant track:** the missing single SDK entry (streaming
   `query()`-style handle) and per-session relocation of the remaining
   module-global registries — the canonical plan's Steps 6–7 / F-1 / F-2, already
   sequenced and partly landed (`SessionHandle`, `AgentRunHandle`). The
   load-bearing `RunCoordinatorBridge` must be **relocated, never deleted**.

## Subagent split points — re-confirmed

No change to the canonical/delta subagent analysis: YAML agent profiles are
near-isomorphic to the SDK `AgentDefinition`; teams (`AGENT_MODE_PRESETS`) are the
subagent roster; `delegate_agent`/`delegate_workflow` + `executeSubagent` are the
isolated-context delegation primitive; read-only-by-tool reviewers
(`changeReviewer`, no bash) already model SDK tool-scoping. The lowest-risk
concrete win remains wiring the existing `review` tool-use agent as a post-draft
**Verifier** delegation; deeper in-agent round decomposition stays gated behind
the per-run-handle state-isolation track.

## Recommendation

**The two open core cleanups are now applied (see Update); no further core
refactoring is warranted at this time.** The audit is current, its
recommendations are landing through a disciplined behavior-neutral PR train, and
the only remaining items are the two larger tracked design pieces (cross-provider
message scaffold; surface / multi-tenant track). Continue executing the canonical
plan's Steps 6–7 / surface track; do not re-open the adjudicated traps.

## Verified (this checkpoint)

- `packages/core/src/index.ts` (line count), `src/platform/interfaces/workspace.ts`
  (no `watch`), `src/agent/core/flows/ResponseCycleFlow.ts:444-462` (finalize guard).
- grep: `getDefaultAgentRuntimeHost` (empty); the `*FlowParams` aliases (now
  removed) and the duplicated `refreshClient` closures (now centralized in
  `CycleServices.withModelClient`).
- `git log` since 2026-06-23 over `src/agent src/logger src/platform packages/core`
  (the landing commits cited above).

## Verified (2026-06-25 applied pass)

- `npm run typecheck` — exit 0 across all four projects (root, test-kernel,
  `texra`, `@texra-ai/cli`).
- `npx eslint` over the 11 touched files — 0 errors (import-order auto-fixed).
- `npx vitest run src/test-kernel/agent` — 649 passed, 4 skipped (across 117
  files). The 5 suites most directly covering this change all passed:
  `ResponseCycleTools`, `ReflectionOutputLocation`, `ToolUseWaitNode`,
  `ToolUseRoundFollowUpMedia`, `RetryState` (these are passing suites, not the
  4 skipped tests).
- Behavior-equivalence of `withModelClient`: the returned literal has the same
  keys/values as the former inline `setServices` argument; the getter closes over
  the same `client` variable `refreshClient` reassigns, and neither call site
  spreads the result — liveness preserved.
