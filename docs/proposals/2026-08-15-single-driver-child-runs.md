# Single-driver child runs: retiring `executeInBand` and `finish()` rewrites

Status: draft for maintainer ruling. Re-opens, at the maintainer's request
(2026-08-15, twice-stated), the `2026-08-03-run-classification-consolidation.md`
ruling that the in-band/detached split is "different durability contracts,
not duplication". This note is the adversarial pass that either produces the
deletion plan or re-affirms the ruling with the _specific_ contract named.

## Smell 1: `executeInBand` is a second driver, not a second contract

Today two drivers execute native child runs: `startChildRunLoop` (detached)
and `executeInBand` (in-band). They share the strategy primitive, the
delivery envelope, and (since item 2) the cost contract — but each still
owns its own registration call, lease scope, failure-persistence policy, and
terminal-release policy. Every consolidation so far has shrunk the delta;
the remainder is the driver duplication itself.

**Proposed shape.** One driver. An "in-band" caller becomes _a caller that
awaits the one loop's completion and reads the typed result_:

- `startDetachedChildRunLoop({ deliveryMode: 'persistOnly', … })` already
  exists for headless callers that own the report themselves — the loop
  supports terminal-only strategies with no `runTurn` (the workflow-script
  strategy is the precedent).
- The awaiting caller reads `/executions/{id}/result` (already
  required-persisted on this path) instead of receiving a return value from
  a parallel execution function.
- The stable-attempt ledger (reserve → launch-guard → recover) wraps the
  _same_ launch primitive rather than gating a second one; replay recovery
  stays exactly where it is, checked before any physical work.

**Adversarial checks that must pass before any code moves** (any one can
kill the fold — in which case this note records the named contract and the
ruling stands):

1. **Error taxonomy.** In-band callers consume `SubagentDurabilityError` /
   `SubagentReconciliationError` synchronously. The loop converts failures
   into persisted terminal state. Does `ResultMeta` (plus the terminal
   execution record) carry enough to reconstruct that taxonomy at the
   awaiting caller, or does the typed-throw channel _require_ a synchronous
   driver? If the latter, that is the real "different durability contract" —
   name it and stop.
2. **Lease scope.** The in-band path deliberately retains a distinct
   terminal-release policy (H3 residue). Confirm the loop's
   release-after-artifacts is equivalent for a single-cycle child, or that
   the difference is expressible as a loop option without a second policy
   ladder.
3. **Queue semantics.** The loop acquires a follow-up queue lease per child;
   single-cycle children never consume follow-ups. Confirm acquisition is
   harmless (the workflow-script terminal-only strategy already does this)
   rather than a semantic change.
4. **Budget inheritance.** In-band children inherit the parent's slot
   (2026-08-15 budget note). The awaiting-caller form must not set
   `budgeted`, preserving that ruling.
5. **Cancellation.** `executeInBand` observes `options.signal` at defined
   points without rewriting a completed child's manifest. The awaiting
   caller must get the same guarantee from `completion` + interrupt.

**Expected win if the checks pass:** `executeInBand` (~180 LoC of parallel
driving) and the second terminal-release policy delete; the attempt ledger,
recovery, and both option surfaces survive unchanged. The XML-delivery vs
typed-result split (a standing non-goal) is untouched — this folds the
_driver_, not the delivery surfaces.

## Smell 2: `finish()` reclassification is a second writer of call outcomes

`agentPrimitive` settles call outcomes on every path it controls; at seal,
`finish()` _rewrites_ still-live calls (PLANNED → skipped/not-reached, live
→ failed with the unfinished note). Two writers of one fact — and the smell
is now load-bearing: the progress projection distinguishes reclassified
calls **by comparing the error string** to `WORKFLOW_CALL_UNFINISHED_NOTE`
(added for card parity in PR #10475), which is exactly the kind of
note-sniffing a first-class fact would delete.

**Proposed shape.** Settlement is the only writer. `finish()` still sweeps —
the abandoned-runner case makes that unavoidable — but the sweep _settles_
through the same `settleCall` API with first-class outcomes instead of
rewriting: either two new statuses (`notReached`, `abandoned`) or a
`settledBy: 'call' | 'seal'` discriminator on the call record. The
projection and the settle sweep then read a typed fact, not an error
string; `deriveWorkflowCounts` and the card vocabulary widen once,
deliberately.

**Adversarial checks:** persisted-snapshot compat (the status enum is
persisted — union widening needs the read-compat check the schema rules
require); host card vocabularies (`WorkflowCallProgress` is a wire schema);
whether `counts.skipped` semantics change for not-reached calls (today they
count as skipped — keep the projection stable by mapping, not by renaming).

## Check verdicts (2026-08-15, read-only pass against head)

The maintainer ruled "consolidate"; the five checks ran and the fold is
**feasible**. What the checks found:

1. **Error taxonomy — passes.** The taxonomy's only consumer is
   `workflowScriptAgentRunner:~397`, which converts any
   `SubagentDurabilityError` (reconciliation included) into a
   `WorkflowRunAbortError`. Its entire consumed meaning is one bit:
   infrastructure fault → abort the run, vs ordinary child failure → the
   call resolves null. Under one driver that bit maps cleanly onto "loop
   completion rejected" vs "completion resolved, persisted outcome failed".
   The ledger's reservation/inspection/recovery throws stay synchronous and
   ledger-side, untouched.
2. **Lease scope — passes.** Both paths already converge on
   `runFlowWithLifecycle` for per-turn handle finalization; the loop's
   dangling-handle sweep covers the inter-turn gaps. The in-band explicit
   `releaseExecutionLeaseAfterArtifacts` collapses into the loop's existing
   release, with the failure-does-not-mask-run-error wrinkle expressed once.
3. **Queue semantics — passes.** The workflow-script terminal-only strategy
   is the precedent: the loop's queue lease is harmless for a child that
   never consumes follow-ups.
4. **Budget — trivial.** The awaiting-caller form omits `budgeted`.
5. **Cancellation — passes.** The same strategy's `params.signal` binding
   covers the run; the awaiting caller aborts via the registered handle.

**The one genuine contract underneath** (the honest core of the 2026-08-03
ruling): the ledger requires the child's typed result _durably persisted_
before the logical call completes — recovery inspects `resultMeta`. That is
a _persistence-mode option on the one driver_ ("required" vs the detached
path's best-effort), not a second driver. The fold therefore proceeds as:
ledger wrapper → loop-driven run (persistOnly delivery, required result) →
await completion → read `resultMeta`; `executeInBand`'s parallel
register/guard/launch/release choreography deletes.

## Sequencing

Smell 1 implements next on this branch (checks passed above); smell 2 is
independent and smaller. Both are measured against the net-gain bar — if
the fold nets positive LoC or forces a wider option surface, the honest
outcome is the named-contract record, per the item-8 precedent.
