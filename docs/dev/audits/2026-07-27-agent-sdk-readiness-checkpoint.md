# Agent SDK Readiness — Verification Checkpoint (2026-07-27)

**Status:** Verification checkpoint. Read alongside the immediately prior
[`2026-07-26-agent-sdk-readiness-checkpoint.md`](./2026-07-26-agent-sdk-readiness-checkpoint.md),
the foundation-gap analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](../../proposals/2026-07-26-agent-sdk-foundation-gap.md)
(whose §6 "absorption sequence" and §7 acceptance criteria this pass measures against),
the audit of record
[`../dev/audits/2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
the plan of record [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md),
and the `-06-25` → `-07-26` checkpoint chain.

This pass inspected the tree afresh at HEAD `55ee72b` (`CHANGELOG.md` heading
`[0.39.9] - 2026-07-26`). The `-07-26` checkpoint pin `5fc03f9` **is** an ancestor
(`git merge-base --is-ancestor` succeeds); `git rev-list --count 5fc03f9..HEAD`
reports **142 commits**. This pass did not perform a commit-by-commit audit of that
range — it re-inspected the tree at HEAD and reconciled against the standing record.

**Run context (honesty note).** This was an **unattended scheduled run** with **no
external adversarial review available** (no Codex second pass). It therefore applies
**no code change** — see "No change lands." The discipline is the same one the `-07-22`
checkpoint's applied-then-reverted `MapToolRegistry` mistake established: this class of
change needs a reviewer outside the pass's own analysis, which an unattended run lacks.

## Verdict — well-aligned, and the posture has materially improved

**The codebase remains well-aligned and SDK-ready in shape; no new structural
refactoring is warranted this pass.** The core-shape conclusion every checkpoint since
`-06-26` has reconverged on holds unchanged.

**The one genuinely new fact vs. every prior checkpoint:** the strategic /
foundation-gap items that earlier passes recorded as _"gated, not applied unattended"_
are **no longer purely deferred**. A large fraction of the `-07-26` foundation-gap §6
absorption sequence and §7 acceptance criteria **landed in reviewed PRs** during the
142-commit window. Prior checkpoints could only say "recorded, not applied"; this one
records "applied — by the maintainer, in review." The readiness gap is closing through
the correct channel (attended, reviewed PRs), not through unattended runs. That is the
system working as the `-07-22` lesson intended.

## Spine invariants — re-verified at HEAD `55ee72b`

- `src/agent/core/index.ts` **absent** (no barrel regression).
- `IModelHandler = Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:41`).
- `Node.exec → createFlow().run` shape intact: `ResponseCycleNode.exec()` creates and
  runs `createResponseCycleFlow<C>()` inline (`ResponseCycleNode.ts:105`), no wrapper.
- **0** `vscode` imports across all declared VS Code-free zones (`src/agent`, `model`,
  `latex`, `tools`, `controllers`, `shared`, `replacement`, `eventBus`, `hosts`,
  `logger`).
- Ratchets present and enforcing: `config/ratchets/host-agent-import-baseline.json`
  and `config/ratchets/knip-baseline.json`.
- `MapToolRegistry` still `Map<string, ITool> | Record<string, ITool>` with the
  `instanceof Map` branch (`ToolTypes.ts:50-51`) — the reverted `-07-22`/`-07-23` state,
  correctly not re-attempted.
- `agentCreatorFlow.ts` still contains **0** `Node`/`Flow`/`@agent/node` references — a
  linear async function, not a flow; CLAUDE.md's "not a flow" note is accurate.

## Landed since `-07-26` — foundation-gap items now in the tree

Verified present at HEAD (commit refs from `git log 5fc03f9..HEAD`):

| Foundation-gap item                                                                            | Landed as                               | Verified at HEAD                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6.1 — declare `runScope` on the flow-services type (kill the ambient `RunContext` erasure)    | `b114d5b` (#9267)                       | `BaseFlowServices.runScope` (`:21`); `CommonCycleTypes`/`ModelInvocationNode`/`RetryState` read `services.runScope`. **Ambient ALS reads inside `core`/`flows` collapsed from 11 → effectively 1** (only `RoundPersistedFlow`'s log-grouping `set`, not a `runScope` read). This was the highest-value single item in the foundation-gap doc. |
| §6 / §7-row-6 — repair runs when the store opens (closes CLI parity hole)                      | `3809b6e` (#9273), `ec18ad6` (#9295)    | crash-repair now fires on session/stream open; CLI no longer blind.                                                                                                                                                                                                                                                                           |
| §7.1 step 1 — delete the 5 producerless `show*` arms                                           | `96831e6`                               | `runtimeInteractionEvents.ts` **deleted**; 0 `show*` arms in `src/agent/runtime/`.                                                                                                                                                                                                                                                            |
| §7.1 step 2 — one approval-bypass rail                                                         | `4279d90`                               | bypass notifications unified.                                                                                                                                                                                                                                                                                                                 |
| §7.1 step 3 — tool-edit prompts become host-local                                              | `8e3d367` (#9272)                       | `RuntimeInteractionEventPayloads` tool-edit arms gone from runtime.                                                                                                                                                                                                                                                                           |
| §7.1 step 4 / row 7 — implement `AgentRuntimeHost.emit`, delete the extension presentation bus | `9a12686` (#9251/#9262)                 | `emit` implemented on the extension host and `extensionPresentationEvents.ts` **deleted** — verified absent at HEAD; no `presentationEvents`/`PresentationBus` remnants remain.                                                                                                                                                               |
| §7 row 5 — one status rail (13 → 10 apply-sites)                                               | `5007b29` (#9250), `917f7c7`            | status collapsed onto one rail via the mechanism the `-07-26` §7 correction prescribed (hub at `StreamStatusMachine` construction), not the disproven guard-drop; `SessionHandleInit.status` seam dropped.                                                                                                                                    |
| Acceptance row 1 — `SessionHandle` owns its snapshot store                                     | `8ed6ae3` (#9234)                       | `StreamSnapshotStore` now attached/flushed via `SessionHandle`.                                                                                                                                                                                                                                                                               |
| Engine hygiene — move `RoundPersistedFlow` out of the generic node engine                      | `4f93ae2` (#9238)                       | done.                                                                                                                                                                                                                                                                                                                                         |
| Bootstrap — CLI registers agent shutdown handlers                                              | `cdb891c` (#9229)                       | done.                                                                                                                                                                                                                                                                                                                                         |
| Cleanup — delete leaky pass-through barrels / dead re-exports / abstraction bypasses           | `5bc5789`, `d0398ff` (#9221), `98ead4e` | done.                                                                                                                                                                                                                                                                                                                                         |

Net effect: the interaction-surface redesign (foundation-gap §7.1) and the ambient-context
erasure (§6.1) — the two items the `-07-26` checkpoint flagged as the highest-value,
longest-standing tensions — are **substantially realized in the tree**. The observe-vs-block
principle now has real teeth rather than being a design on paper.

## Remaining gaps — the real ceiling (§9), unchanged

None of the landed work touches the product-out-of-runtime split, which the
foundation-gap §9 correctly names as the ceiling. Re-verified present at HEAD:

1. **Tool registry is still closed — the one place the surface must _grow_.**
   `IToolRegistry = { get, has }` (`ToolTypes.ts:41-44`), no public `register`; tools
   are hard-coded in `createDefaultTools()` (`src/tools/registry.ts`). An embedder cannot
   add a tool. Unchanged; correctly last on LoC, first on foundation.
2. **Product types leak into the runtime launch path.** `toolConfig` still carries LaTeX
   booleans (`autoCompileInputPdf`, … — `src/shared/schemas/toolConfig.ts`);
   `AgentFlowResult.compileFailures` (`:34`) still rides the generic flow result;
   `RunAgentOptions.preferHelperModel` (`runAgent.ts:54`) is still a VS Code "fix LaTeX"
   feature flag on the root-launch options (its own comment at `:92-96` admits this).
   This is the product-out-of-runtime split — a design decision, not tidying.
3. **`IModelHandler` port width (44 members) and `SdkToolCall` vendor-type embedding**
   remain the standing strategic port-shape item (`-07-23` item 5, `-07-26` items 5–7).
   `IModelHandler` is still auto-derived `Pick<ModelHandler>`, so this is a surface-shape
   observation, not drift. Gated behind a real port cut.
4. **NS-1 host→core public surface.** Hosts still reach `@agent/*` deep specifiers frozen
   by the enforcing ratchet; no Tier-1 manifest yet. Strategic, sequenced.
5. **Partial: `stateOwnership` not fully retired.** `SessionHandle` now owns the snapshot
   store (#9234), but `stateOwnership` still has **8 live (non-test) references** —
   `ProgressBackend` (`:75,107,114,294,315`), `ProgressViewState.load` (`:519,530`), and the
   desktop caller passing `stateOwnership: 'session'` (`desktopAgentExecution.ts:259`) — and
   `StreamSnapshotStore`'s header still declares itself the "SINGLE writer" with host-owned
   public mutators. Acceptance row 1's "symbol absent" target is therefore not yet met. This is
   the tail of the #9234 absorption, gated behind a real ruling — not touched here.

## No change lands (by design this pass)

Consistent with every unattended checkpoint since `-07-22`. The lowest-risk candidates
this pass could see (e.g. the foundation-gap §4 "dead field" claims —
`AgentLaunchInput.taskType`, `CreateLaunchRunContextOptions.model`) were **not applied**:
the `-07-22` revert is the worked example that a grep-justified "obviously dead/safe"
change can hide an incomplete caller census, and only an out-of-pass reviewer reliably
catches it. `taskType` in particular is no longer a clean "0 setters" case at HEAD — it
carries a constructor-parameter default (`AgentLaunchContext.ts:459`), so even that claim
would need re-derivation before any edit. Record it; do not apply it.

`MapToolRegistry` re-checked and still `Map | Record` with the `instanceof Map` branch —
**do not re-attempt the narrowing without a deliberate compatibility boundary for `Map`
inputs.**

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched; the standing verification is carried forward.
- No commit-by-commit audit of the 142-commit `5fc03f9..HEAD` range — a fresh state
  inspection at HEAD reconciled against the standing record instead. The "Landed" table
  is verified by presence-in-tree plus the commit subject line, not by reviewing each PR's
  diff.
- Counts other than the directly-grepped spine invariants (ALS-read count, `stateOwnership`
  references, tool count) are re-derived this pass, not re-audited to full forensic scope.
- This checkpoint lives under `docs/proposals/` (internal, excluded from the texra.ai
  publish allowlist) — not a root-level doc, so it does not touch the `docs-root-boundary`
  gate.

## Correction to this checkpoint (same-day)

The first commit of this checkpoint claimed `extensionPresentationEvents.ts` "still exists"
as a minor follow-up. **That was wrong** — an artifact of a `find … && echo EXISTS` probe
that fires even on no match (`find` exits 0 with empty output). Re-checked with an explicit
existence test: the file is **absent**, and `9a12686` (#9251) deleted the presentation bus in
full as intended. The "Landed" table and "Remaining" list above are corrected accordingly.
The `stateOwnership` follow-up, by contrast, was re-verified and **stands** (8 live references,
enumerated above). Recorded here rather than silently amended, per the repo's correction
convention.

## Correction to this checkpoint (PR-merge)

The "No change lands" section above (lines 109–118) states that the `taskType` dead-field
removal was **not applied** and that `taskType` carries a constructor-parameter default at
`AgentLaunchContext.ts:459`. **This was true when the checkpoint was drafted** (the
unattended pass correctly deferred the change per the `-07-22` discipline), but the
maintainer re-derived the claim in an attended PR and determined that `taskType` is the
one genuinely behavior-neutral candidate — **0 setters** repo-wide, a parameter default
that was never overridden, and a byte-identical error string after inlining `'Task'`.
The removal was therefore applied in commit `5c2b81f` (this PR) against the
checkpoint's recommendation: the field, the forwarded argument, and the now-constant
parameter are removed from `AgentLaunchContext.ts`. The "no longer a clean 0 setters
case" framing and the `:459` line-number reference are stale as of the merge commit.
The checkpoint's broader principle — that unattended passes should not apply structural
changes without out-of-pass review — is affirmed by this outcome: the change landed
_only_ after re-derivation by a maintainer in an attended PR, which is exactly the
safeguard the `-07-22` revert mandated.
