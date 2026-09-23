---
created: 2026-09-21
status: proposed
---

# One run program family: acquireUseRelease at two scales, one state cell, reflection output as folded run.fact rows

Winners per judge: Proposal 2 (Effect primitives as designed), total 18. It is the only one that gets the central primitive judgement right in both directions — Effect.onExit is already the exit bracket, so it refuses to wrap it in a project-local runProgram combinator with a six-callback spec, and it puts Effect.uninterruptible where it actually belongs, inside the one append. It finds the two real correctness holes on this seam (the interruptible append leaving the halt row's state stale and its refusal swallowed into logger.warn; Cause.hasInterrupts recording an interrupted failure as CANCELLED where Cause.hasInterruptsOnly is the predicate that means a stop), it refuses the new row type with the strongest evidence (#12912 = 7543bdc755, LISTING_GROUP at Database.ts:162, listingKeyOf at sessionEvent.ts:694-698, the RunLedgerDraft narrowing comment at runStateFold.ts:66-70), and it has the only landing plan that fits the tree: steps 1-4 behaviour-preserving as one PR, the ModelInvoker/dispatch cell and the output rows separate. It should be landed with three grafts (below), which raise it to roughly P1's deletion count and P3's outer shape without taking either one's flaw., Proposal 2 (Effect primitives as designed), total 18. It wins on the two axes the mandate weights hardest and on verification quality. On effectIdiom it is the only one that finds a live correctness defect in the thing being refactored (Cause.hasInterrupts vs Cause.hasInterruptsOnly, verified at Cause.ts:1060 and :624) and the only one whose collapsed state cell closes a reachable hole rather than renaming it: the 7+7 unwrapped `commit(yield* ledger.appendBatch(...))` pairs have an interruption point between the durable commit and the Ref.set, so the finalizer can author a halt against a state behind the rows, and only P2's RunCell.append makes read-append-write one uninterruptible region — which also absorbs the nine hand-written wrappers at the exact lines it cites. On singleOwner its key-narrowed `run.fact` arm in RunLedgerDraft is the only mechanism proposed that makes 'the loop owns the output maps, a tool owns todos/plan' a compiler-checked fact rather than a convention, and runStateFold's IGNORED_ROW_TYPES record (verified total at :242-253, with 'run.fact': true at :253) turns the reclassification into a compile error by its own design. It is also right to refuse the task's own premise: the premise says the cold listing keeps MAX(seq) per (aggregate_id, type), but Database.ts:162 shows LISTING_GROUP already carries the `$.fact.key` discriminator, sessionFold.ts:1467-1481 already folds all three output maps off run.fact, and #12912 (7543bdc755) consolidated five row types into that one keyed row — so what is broken is the channel (logger.emit -> detachPublication, fire-and-forget, with no barrier before the round-closing batch, unlike toolUse's settlePublications at toolUse.ts:819) and the fold (runStateFold.ts:253 ignores run.fact while sessionFold folds it: two folds, same rows, same question, R1's named defect), not the vocabulary. Land P2 with the six grafts below, which raise its fewerElements to P1's level without giving up its correctness edge.

## Decision

Take Proposal 2's judgement (Effect.onExit already is the exit bracket, so no project-local runProgram combinator with a callback spec) and replace its enterRun-then-onExit pairing with Proposal 3's Effect.acquireUseRelease, which is the same bracket plus an uninterruptible acquire and release-only-if-acquired, verified at node_modules/effect/dist/internal/effect.js:1872 and node_modules/effect/src/internal/effect.ts:4346-4358. The run becomes one acquireUseRelease whose resource is a RunCell (one Ref, one uninterruptible read-append-write, the single ledger writer per run), whose use is the family's own for(;;) generator, and whose release is one shared settleRun that maps the body's typed Exit to a verdict. The same primitive carries the per-turn trace stage, so no Scope per turn is added and both mutable stage-verdict variables die. Reflection's round map stops being a snapshot field and becomes a key-narrowed run.fact arm of RunLedgerDraft, folded in runRows.ts and committed in the round-closing batch: no new row type, because Database.ts:162's LISTING_GROUP already groups MAX(seq) by aggregate_id, type, json_extract(data,'$.fact.key') and 7543bdc755 (#12912) is the owner's own consolidation of five row types into that one keyed row. Alongside that, twelve persisted fields and three schemas that restate what rows already carry are deleted under one-run-model R1, and totalResponseTimeMs moves into the derived usage fold. Four PRs, exactly one SESSION_EVENT_FORMAT bump, rebased onto int/snapshot-and-one-fold-0921d rather than landing beside it.

## Design

## 0. What is actually shared, and what is not

Both loops are already one Effect program over the ledger. Reading them, the duplication is three different things and only one of them is scaffolding.

Genuinely shared lifecycle: `fresh` (toolUse.ts:407-415 and reflection.ts:376-384, identical but for the family literal, comment included), the resume-refusal block (toolUse.ts:706-726 and reflection.ts:1173-1191, copied with its #11313 citation), `finalize` (toolUse.ts:886-933 and reflection.ts:1315-1341), `failure` (toolUse.ts:936-945 and reflection.ts:1344-1351), `usageSnapshot` (toolUse.ts:446-453 and reflection.ts:329-336), `openFresh`'s tail (`run.callbacks.onProgress?.({kind:'started'})` then commit, toolUse.ts:402-403 and reflection.ts:412-413), and the `Ref.make<RunState|null>` plus `commit` pair (toolUse.ts:144-146, reflection.ts:284-286).

Mirrors of durable facts, which are the reason the pairs exist at all: `let lastError` mirroring `RunState.lastError` (toolUse.ts:152, reflection.ts:291); reflection's `flow.currentRound` mirroring `runtime.round`, which is the only reason `coordinates()` exists (reflection.ts:321-327) and the only reason PR #12767 needed a `coordinatesOf` resolver; two hand-rolled `totalResponseTimeMs` accumulators (toolUse.ts:150/425-426/669, reflection.ts:304/335/1144-1145); and the reflection round map, which today has four durable carriers.

Two correctness holes, both reachable:

- The state cell is written outside any uninterruptible region. `rg -c "ledger.appendBatch"` gives 7 in toolUse.ts and 7 in reflection.ts; of those 14, exactly one is wrapped (reflection.ts:1125). ModelInvoker wraps 7 of its 8 (536, 596, 727, 1025, 1108, 1126, 1241) and toolUseDispatch 1 of its 2 (283). So an interrupt delivered between a durably committed batch and `Ref.set(latest, next)` leaves the finalizer holding a state behind the rows; its `appendBatch(runId, staleState, [halted])` then folds a `halted` step onto a state missing rows already committed and is refused, and that refusal is swallowed into `logger.warn('Failed to record the run halt')` (toolUse.ts:899-906, reflection.ts:1328-1335). That is exactly the failure the comment at toolUse.ts:879-885 records as already fixed once, reachable one level down.
- Both verdict ladders branch on `Cause.hasInterrupts` (toolUse.ts:921, reflection.ts:1336). Effect's own doc at node_modules/effect/src/Cause.ts:1053 says `hasInterruptsOnly` is "`true` only when _all_ reasons are interrupts", and :1049-1050 shows `hasInterrupts(Cause.fail("error"))` is false but any interrupt riding alongside a real failure makes it true. So a run that failed and was then interrupted while unwinding is recorded CANCELLED.

And two durability defects the crash lens found, both confirmed:

- Tool-use performs no family check on resume: `const flow = toolUseFlowState(state); if (flow === null) return;` (toolUse.ts:417-419). A reflection run resumed as tool-use continues silently with an empty workspace, where reflection fails loudly (reflection.ts:421-425).
- `contextWindowRecoveryAttempted` (reflection.ts:297) is a process-local boolean gating the once-per-round forced-compaction retry and appears in no schema, so a crash mid-round buys a second forced compaction and a second billed attempt on resume.

## 1. The shape: acquireUseRelease at two scales

`Effect.acquireUseRelease(acquire, use, release)` is, verbatim, `uninterruptibleMask(restore => flatMap(acquire, a => onExitPrimitive(suspend(() => restore(use(a))), exit => release(a, exit), true)))`. Three properties fall out that both loops hand-roll today:

1. Release runs on every exit, uninterruptibly. The hand-written `Effect.uninterruptible(...)` wrapping both `finalize` bodies (toolUse.ts:887, reflection.ts:1316) deletes; the comment both files carry about `onExit` beating `Effect.exit` stays true and becomes structural.
2. Acquire is uninterruptible. A stop arriving during the opening batch today lands in `finalize` with `latest === null` and writes no halt row at all. After, the opening completes and release sees an interrupt exit, so the run is durably halted and resumable instead of durably ambiguous.
3. Release only runs on an acquired resource. "The run has rows and a phase" becomes acquire's postcondition, which deletes the `state === null || state.phase === null` guard both halts repeat (toolUse.ts:892-894, reflection.ts:1320-1322).

The release's `exit` is `Exit<A, E>`, the body's own typed exit. That is the whole reason this primitive, and not `Effect.acquireRelease` inside `Effect.scoped`, is the right one for the per-turn stage too: a Scope's finalizer receives `Exit<unknown, unknown>`, which is exactly why reflection keeps `let roundOutcome` (reflection.ts:1062) and reads it in preference to the exit (reflection.ts:1077-1084). **Answer to "a Scope per turn": no.** The turn owns no releasable resource but the stage handle, and the stage needs the body's value, so it is `acquireUseRelease`, one primitive at two scales, and both `stageOutcome` (toolUse.ts:484) and `roundOutcome` delete.

**Reject the family-parameterised program.** A `runProgram(spec)` taking `open`, `restore`, `seed`, `loop`, `verdict`, `release` inverts control into the framework CLAUDE.md's "There is no flow engine ... Do not add a node, a cursor, a services bag" rules out, and a record of hooks is a services bag in costume. The bodies that differ are large and stay large: tool dispatch with its approval and barrier protocol (toolUseDispatch.ts, 1007 lines, no reflection analogue), reflection's continuation cycle, and the follow-up park/wait/child protocol (toolUse.ts:729-793). The family is not a parameter either: it is `RunState.family`, which `familyOf` already reads (rows.ts:66-73).

So the shared module holds values and total functions, and each loop writes its own three-argument `Effect.acquireUseRelease` call.

## 2. `src/agent/runtime/loop/runProgram.ts`

Six exported values, three exported types, no callback record.

### 2.1 `RunCell`: the run's one state holder and its only ledger writer

```ts
export interface RunCell {
  readonly runId: RunId;
  /** The state the loop continues from. Nothing mirrors it. */
  readonly current: Effect.Effect<RunState>;
  /** Commit one batch against the current state; adopt what the ledger folds
   *  back. Read-append-write is one uninterruptible region, so a stop can
   *  never leave the cell behind the rows. */
  readonly append: (
    rows: readonly RunLedgerDraft[],
  ) => Effect.Effect<RunState, RunLedgerRefused | DatabaseWriteFailed>;
  /** Adopt a state a run service already committed against (ModelInvoker,
   *  dispatchPendingResponse, FollowUps.consume, compactIfNeeded). */
  readonly adopt: (state: RunState) => Effect.Effect<RunState>;
}

export const makeRunCell = (
  runId: RunId,
  opened: RunState,
): Effect.Effect<RunCell, never, RunLedger>;
```

`Ref`, not `SynchronizedRef`: one fiber owns a run (the loop, the invoker and the dispatcher all run on it), so a lock would be a primitive bought against no contention. (Amended by PR-D: the premise does not hold for the dispatcher, whose parallel partition settles calls on sibling fibers that each fold onto the one before, which is why `toolUseDispatch` held its own `SynchronizedRef`. Once the cell reaches dispatch it is that `SynchronizedRef`, and `append` also takes a `(state) => rows` builder so rows that read the state are built from the state they commit against.) The cell is seeded with a non-null `RunState` because it is created inside acquire, after the run is opened or restored, which is what removes the null branch from every reader.

Every `state = yield* commit(yield* ledger.appendBatch(runId, state, rows))` becomes `state = yield* cell.append(rows)`. `RunLedger` stays stateless by construction (runLedger.ts header: the loop holds the RunState); the cell lives on the run, not on the session-root service.

### 2.2 `loadRun`: the entry, as data, not hooks

```ts
export type RunEntry =
  /** No opening row yet. `loaded` may still carry queued follow-up rows. */
  | {
      readonly _tag: 'fresh';
      readonly loaded: RunState | null;
      readonly opening: RunState;
    }
  | { readonly _tag: 'restored'; readonly loaded: RunState };

export const loadRun: (
  runId: RunId,
  family: RunFamily,
  resume: boolean,
) => Effect.Effect<RunEntry, Error, RunLedger | AgentRun>;
```

It takes the claim when resuming, loads the aggregate, raises both refusals once (`NOT_RESUMABLE_MESSAGE` and the #11313 "already has ledger state; resume it instead"), raises the family check for both families, and on the fresh arm builds the opening state both `fresh` closures build identically by reading `SynchronizedRef.get(run.model)` and `run.declinedRoutes`. The caller branches on the tag; `followUps.seed(entry.loaded)` works on both arms without narrowing, which is why `loaded` is a field of both.

Note the copy collapses inside itself: both files write `if (!start.resume && loaded.phase !== null)` (toolUse.ts:718, reflection.ts:1181) where the second conjunct is already established by the enclosing branch.

### 2.3 `RunExit` and `settleRun`: one verdict, no verdict callback

Give both loops the same exit value, so the release needs no `outcomeOf` lambda at all:

```ts
/** What a run program returns. `outcome: null` is a park: the launch ended
 *  without ending the run, so no `halted` step is written. */
export type RunExit = {
  readonly state: RunState;
  readonly outcome: RunOutcome | null;
};
```

Tool-use's `LoopExit` waiting arm becomes `outcome: null`; reflection's is already `RunOutcome`. The verdict is then one total `Exit.match`:

```ts
const runVerdict = (exit: Exit.Exit<RunExit, Error>): RunOutcome | null =>
  Exit.match(exit, {
    onSuccess: (value) => value.outcome,
    onFailure: (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? RUN_OUTCOME.CANCELLED
        : RUN_OUTCOME.FAILED,
  });

/** The exit protocol: the halt row and, where a family holds one, the input
 *  lease. A write failure only logs: the run is already unwinding and has
 *  nothing left to surface it to. */
export const settleRun: (
  cell: RunCell,
  logger: AgentTrace,
  /** The family's input lease, or null. Typed data, not a service lookup:
   *  a missing FollowUps must not leak a lease with nothing saying so. */
  lease: FollowUps | null,
) => (
  exit: Exit.Exit<RunExit, Error>,
) => Effect.Effect<void, never, RunLedger | Runs>;
```

Its body: `const outcome = runVerdict(exit); if (outcome !== null) { const state = yield* cell.current; yield* cell.append([haltedStepRow(runId, state, outcome)]).pipe(Effect.catch(warn)); } lease?.release(outcome === RUN_OUTCOME.COMPLETED && !runs.hasActiveChildren(runId) ? 'terminal' : 'recoverable')`.

One expression replaces the four-branch ladder at toolUse.ts:909-931, case by case: park gives no halt and a recoverable lease; COMPLETED halts and is terminal unless `hasActiveChildren`; every other outcome, interrupt or failure halts and is recoverable. Reflection passes `lease: null`.

### 2.4 `stoppedBy` and `stagedBy`

```ts
/** The caller's error for a run that ended in a failure cause; an interrupt
 *  cause is re-raised unchanged. Absorbs PR #12767's runExitFailure. */
export const stoppedBy: (
  logger: AgentTrace,
  label: string,
) => (cause: Cause.Cause<Error>) => Effect.Effect<never, Error>;

/** A trace stage whose verdict is the body's own exit. acquireUseRelease,
 *  not a Scope: a Scope's finalizer sees Exit<unknown, unknown> and cannot
 *  read the body's value, which is why both loops keep a mutable verdict. */
export const stagedBy: <A>(
  open: () => StageHandle,
  outcomeOf: (value: A) => RunOutcome,
) => <E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
```

`stagedBy`'s release is `(stage, exit) => Effect.sync(() => stage.end(Exit.isSuccess(exit) ? outcomeOf(exit.value) : Cause.hasInterruptsOnly(exit.cause) ? CANCELLED : FAILED))`. Two callers, real logic, captured context: it passes the factory bar. It also fixes an asymmetry: today an interrupted tool-use turn closes its stage FAILED (`let stageOutcome: RunOutcome = RUN_OUTCOME.FAILED`, toolUse.ts:484, closed in a `finally` at 687-690 that cannot see an exit) while an interrupted reflection round closes CANCELLED.

### 2.5 The call sites

Tool-use:

```ts
const enter = Effect.gen(function* () {
  const entry = yield* loadRun(runId, 'toolUse', start.resume);
  followUps.seed(entry.loaded);
  const opened =
    entry._tag === 'fresh'
      ? yield* openFresh(entry.opening)
      : (restore(entry.loaded), entry.loaded);
  return yield* makeRunCell(runId, opened);
});

return (
  yield *
  Effect.acquireUseRelease(
    Effect.sync(attach),
    () =>
      Effect.acquireUseRelease(enter, loopBody, (cell, exit) =>
        settleRun(cell, logger, followUps)(exit),
      ),
    () => Effect.sync(detach),
  ).pipe(
    Effect.map((loop) =>
      loop.outcome === null
        ? result(RUN_PHASE.WAITING, loop.state)
        : result(loop.outcome, loop.state),
    ),
    Effect.catchCause(stoppedBy(logger, `Tool-use run ${runId}`)),
  )
);
```

The host attachment leaves the exit protocol and becomes its own bracket. Ordering moves: today `detach()` runs before `followUps.release`, after this it runs after; the mid-loop detach/attach around a blocking wait (toolUse.ts:781, 789) stays as it is, idempotent under the `live` flag. Reflection is the same with no attachment bracket, `lease: null`, and `Effect.map((loop) => result(loop.outcome, loop.state))`.

`loopBody` is unchanged in shape: `Effect.gen` with `for (;;)`, reading `yield* cell.current` at the head of each iteration and writing through `cell.append` / `cell.adopt`.

### 2.6 What carries the loop, and what does not

- **`Effect.iterate` does not exist.** Probed against the installed effect 4.0.0-rc.115: `Effect.iterate`, `Effect.loop` and `Effect.tailRec` are all `undefined`; only `whileLoop`, `forever` and `repeat` exist. `Effect.whileLoop` takes `while: LazyArg<boolean>` with no state parameter and a void-returning `step`, so threading `RunState` through it requires an external mutable cell and a sync predicate over it: strictly more machinery than the generator, and it cannot express "the next phase depends on what `appendBatch` just returned".
- **`Stream.unfold` is rejected.** A stream's completion carries no value, so the exit verdict would have to be reconstructed outside it; nothing consumes turns as elements; and it adds a channel, a sink and a drain to express a loop whose state already lives in the ledger. It deletes nothing.
- **`for (;;)` inside `Effect.gen` stays.** The generator is already the trampoline, each `yield*` is a fiber step, and the per-iteration state is the `RunState` the cell returned. The file headers already say this is the design.

## 3. `rows.ts`: three snapshot constructors become one

`snapshotRow` (rows.ts:223-232), `reflectionSnapshotRow` (rows.ts:235-244) and `runtimeSnapshotRow` (rows.ts:251-265) are three faces of `buildSnapshot` (rows.ts:155-216). `runtimeSnapshotRow` is the general case, not a fourth thing: it already passes `state.flow` and already serves both families from four production sites (ModelInvoker.ts:289 and :1243, FollowUps.ts:197, reflection.ts:1127). Make it the survivor, rename it `snapshotRow`, and give it one optional residual `state`:

```ts
export function snapshotRow(
  runId: RunId,
  state: RunState,
  patch: {
    /** Defaults to the folded phase: the runtime-only case. */
    readonly phase?: RunLoopPhase;
    readonly round?: number;
    readonly turn?: number;
    readonly continuationIndex?: number;
    readonly runtime?: Partial<
      Pick<
        SnapshotRuntime,
        'modelId' | 'modelCompatibilityKey' | 'lastError' | 'declinedRoutes'
      >
    >;
    /** Defaults to the family state the run last wrote. */
    readonly state?: FamilyState;
  },
): RunLedgerDraft;
```

with a one-line correlation guard the two-wrapper design never had: `if (state.family !== null && patch.state !== undefined && state.family !== patch.state.family) throw new Error("A snapshot's family is the run's.")`. The `flow.state.modelId` term of the model-id fallback (rows.ts:165-168) goes with the field it reads, leaving `patch.runtime?.modelId ?? state.modelId`. `toolUseFlowState` / `reflectionFlowState` (rows.ts:45-54) collapse to one `familyState(state, family)`. `NOT_RESUMABLE_MESSAGE` moves to `runProgram.ts` with its only callers.

Both loops' local `snapshot()` closures (toolUse.ts:187-196, reflection.ts:314-320) delete: their whole job was splicing `state: flowState(...)` and `lastError` into every patch. `let lastError` deletes with them, because `buildSnapshot` already carries `state.lastError` forward when the patch does not name it (rows.ts:183-189), so stickiness is automatic; the two sites that clear it (toolUse.ts:803, reflection.ts:1128) pass `{ runtime: { lastError: null } }` explicitly, exactly as `FollowUps.ts:197` already does.

`coordinates` (reflection.ts:321-327) deletes and all its call sites pass the folded state. That is a bug fix, not line count: `enterRound` mutates `flow.currentRound` at reflection.ts:1227-1232 **before** its batch commits at :1236-1241, so an interrupt in that window makes `finalize`'s halt row (reflection.ts:1324) carry a round the fold has not reached. Tool-use already passes `state` directly (toolUse.ts:898).

## 4. Reflection output as rows: a folded `run.fact`, not a new row type

**Do not add `output.produced`.** The task premise says the cold listing keeps `MAX(seq)` per `(aggregate_id, type)`, but Database.ts:162 is `const LISTING_GROUP = \`aggregate_id, type, json_extract(data, '$.fact.key')\``, used by the listing query at :167 and the run-record query at :363, and `listingKeyOf`mirrors it at sessionEvent.ts:694-698 with the comment "one`run.fact`family's newest row never suppresses another's". The discriminator-aware grouping the design is being asked to work around already exists and already serves these three families.`sessionFold.ts:1467-1481` already folds all three maps off that row, each row replacing the view's whole map. And 7543bdc755 (#12912, "one run.fact row, one stored-value row, a park row") is the owner's own consolidation of five row types into that one keyed row; re-splitting it needs new evidence and there is none.

What is broken is the channel and the fold, not the vocabulary:

- The channel. `publishOutput` writes its two facts through `logger.emit` (reflection.ts:957-960 and 966-969) and `publishMissingOutputs` through `trace.emit` (outputState.ts:145-151), which reach the store fire-and-forget through the trace subscription, with no path back to the loop for a refusal and no barrier before the round-closing batch. Tool-use needs exactly such a barrier for its transcript rows and has one, with a fifteen-line comment explaining why (`session.settlePublications(runId, { consume: false })`, toolUse.ts:819 and the comment at :805-818). Reflection has none.
- The fold. `runStateFold.ts:253` lists `'run.fact': true` in `IGNORED_ROW_TYPES` while `sessionFold.ts:1467-1481` folds the same rows. Two folds over the same rows answering the same question differently is R1's named defect.

### 4.1 The ownership split, as a type

```ts
type RunFactDraft = Extract<SessionEventDraft, { type: 'run.fact' }>;

/** The three run.fact families the run loop owns. `todos` and `plan` are
 *  authored mid-turn by a tool through the trace (toolUse.ts:475, 479;
 *  src/tools/codex.ts) and have no batch to ride, so they are not here. */
export type OutputFactDraft = Omit<RunFactDraft, 'fact'> & {
  readonly fact: Extract<
    RunFact,
    { key: 'outputFiles' | 'compileFailures' | 'missingOutputs' }
  >;
};
```

Written as `Extract<SessionEventDraft, { type: 'run.fact'; fact: { key: ... } }>` this resolves to `never`: the draft is declared `durable('run.fact', { fact: RunFactSchema })` (sessionEvent.ts:348) with `RunFactSchema` a five-arm discriminated union (rowValues.ts:29-44), so the member's `fact` property is the whole union and is not assignable to the three-arm narrowing, and `Extract` distributes over union _members_, not over a property inside one. `Omit` plus an explicit property is the working spelling.

`RunLedgerDraft` (runStateFold.ts:70-87 on main, :67 on tranche-4) becomes its existing `Extract<...>` union `| OutputFactDraft`. Its header already says it is "an explicit list narrowed from `SessionEventDraft`, never `SessionEventDraft` itself", so a narrowed arm is the shape that comment describes, and the compiler now enforces which writer owns which family.

### 4.2 The fold

`'run.fact'` leaves `IGNORED_ROW_TYPES`. That record is typed `Record<Exclude<SessionEvent['type'], LedgerRowType | 'followup.queued'>, true>` (runStateFold.ts:242-244), so removal is a compile error until the arm is classified, which is that record's own stated design.

Post-rebase the arm lands in `src/shared/session/runRows.ts`, created by 2896c7e58c as "one reducer for the rows both folds read". Both folds read `run.fact`, so it is exactly that file's charter. `SharedRunRow` gains `OutputFactDraft`'s type and `RunRows` gains three round-indexed maps; `runStateFold` projects them onto `RunState.output`, `sessionFold` projects them onto `files`/`outputs`/`compileFailures`/`missingOutputs` as it does today and keeps its own `todos`/`plan` handling. Latest-wins per key, which is the listing's own rule.

### 4.3 The writer moves into the round's batch

`publishOutput` and `publishMissingOutputs` return their drafts instead of emitting; `produceOutput` (reflection.ts:1031-1052) returns them with the state; `enterRound` (reflection.ts:1236-1241) and `finish` (reflection.ts:1251-1258) put them at the head of their batch. The round's outputs and the row that closes the round then commit in one transaction or not at all, and a refusal reaches the loop typed instead of vanishing. Re-entry at `output.pending` re-runs the pipeline and re-produces the same drafts, which is today's behaviour unchanged (reflection.ts:1026-1030).

Keep the `emitCompileFailures` gate (reflection.ts:852, 887, 903, 940, 961). It is a real policy and this lane must not silently widen what a run publishes.

`restore` then hydrates `outputState.rounds` from `state.output` instead of `persisted.roundOutputs`, so `roundsToPersisted` / `roundsFromPersisted` (outputState.ts:59-78) delete with their callers. That also disposes of a latent defect: `roundsToPersisted` writes `result[round] = data` into a plain array while its own doc says a round "can in principle be absent without shifting the rounds after it", and the target is `z.array(RoundOutputSchema)` (runFlowState.ts:319), which rejects the `undefined` a sparse index produces.

## 5. The persisted family state, field by field

The test is one-run-model R1 (2026-09-10-one-run-model.md:73-86): "a derived value has exactly one fold; nothing derived is persisted and nothing persisted is derived ... A snapshot that carries a fact no row carries is not a checkpoint, it is a second store ... that gap closes by giving those facts rows." Applied to `FlowSnapshotPayload.state`:

Dead or duplicated, delete outright:

- `shouldSkipCycle` (runFlowState.ts:296): sole production writer `shouldSkipCycle: false` at toolUse.ts:164, zero production readers (ten kernel fixtures only).
- `modelId` / `modelCompatibilityKey` on the tool-use arm (runFlowState.ts:292-295): duplicates of the required `runtime.modelId` / `runtime.modelCompatibilityKey`; `modelId`'s only reader is the third term of the fallback at rows.ts:168, which §3 removes.
- `modelCompatibilityKey` on the reflection arm (runFlowState.ts:326): reflection's `flow` literal (reflection.ts:300-308) never sets it.
- `continueRounds` (runFlowState.ts:321): initialised `true` at reflection.ts:306, read at :361 and :1271, never assigned `false` anywhere in production (the only `false` is HistoryStatus.vitest.ts:94). `shouldContinueNextRound()` reduces to `lastError === undefined && state.round + 1 < totalRounds`.
- `currentRound` (runFlowState.ts:311): duplicates `runtime.round`. Its one reader outside the loop is `snapshotHoldsTerminalCompileRejection` (packages/cli/src/runtime/toolUseResumeData.ts:44-47), which reads `snapshot.runtime.round` instead. **`totalRounds` stays**: it is the round budget, no row carries it, and that same CLI reader needs it.

Derivable, recompute:

- `outputLocation` (runFlowState.ts:315): `outputLocationFor(round)` is pure over `workflowOutputPath({ ext, round })` (reflection.ts:260-263).
- `endTurn` (runFlowState.ts:322): computed at reflection.ts:756 as `finish === 'stop' || finish === 'stop-sequence'` from `finishReasonOf(state.lastTurn)`, and `lastTurn` is folded.
- `roundOutputs` (runFlowState.ts:319): §4.
- `runStateSnapshot` on both arms, and `StateSlices.runStateSnapshot` (runFlowState.ts:270, 317): see below.
- `rawOutputBytes` (runFlowState.ts:339): §6.

The usage accumulator, which is the single largest deletion available: `LedgerRunStateSnapshotSchema` is `{ totalRounds, totalResponseTimeMs }` (runLedgerEvent.ts:544-546 over runFlowState.ts:84-88). `totalRounds` equals `state.round` in both families (toolUse.ts:167, reflection.ts:334) and is never read by its only consumer: `rg -n "totalRounds" src/agent/runtime/UsageMonitor.ts` returns nothing, while `stateGlobal.totalResponseTimeMs` is read at :161 and :197. And `totalResponseTimeMs` is exactly the sum of `NormalizedUsage.responseTimeMs` (runFlowState.ts:49) over the run's `response` rows, which `appendBatch` refuses to accept without its priced usage precisely because "RunState.usage is derived from the rows alone (D12)" (runLedger.ts preconditions). So add `totalResponseTimeMs: z.number().nonnegative().prefault(0)` to `RunUsageTotalsSchema` (usage.ts:141-152, which `EMPTY_RUN_USAGE_TOTALS` picks up for free), accumulate it in the fold beside the existing D12 derivation, and delete `AgentRunStateSnapshotSchema`, `PersistedUsageAccumulatorSchema`, `LedgerRunStateSnapshotSchema`, both `.extend({ runStateSnapshot })` splices, both `usageSnapshot` closures and both `let totalResponseTimeMs` accumulators. `UsageMonitor.recordUsage` takes `state: RunState` and reads `state.usage`.

`workspaceSnapshot` stays, nested for tool-use and top-level for reflection; hoisting it into `SnapshotArmFields` is a separate, optional tidy and is not part of this design. After the deletions the reflection arm is `totalRounds`, `workspaceSnapshot`, `compileFailureContext?`, `unresolvedCompileRejection?`, and the tool-use arm is `stateSlices { workspaceSnapshot, userChannels }`, `systemPrompt?`, `structured?`. Note `compileFailureContext` and `unresolvedCompileRejection` are not redundant with each other: `prepareRound` deletes the context once consumed (reflection.ts:1059-1061) while the rejection flag must survive to the last round for the terminal-rejection rule, and the context needs `result.logExcerpt`, which `CompileFailure.log` (a location) does not carry. They stay, named here so nobody re-derives the question.

`contextWindowRecoveryAttempted` does not become a persisted flag. Add `'context-window'` to `ModelCompactionPayloadSchema.cause`, which today spells both the threshold and the forced overflow compaction `'context-limit'` (compaction.ts:302), and fold `RunState.overflowRecoveredAtRound: number | null` from that row. The gate becomes `state.overflowRecoveredAtRound === state.round`: one folded field, zero persisted flags, and the transcript stops lying about why a compaction happened. That is the R1-correct answer, not a scalar on the snapshot.

## 6. Raw output: idempotent by coordinate, not by byte offset

`writeOutputFragment` (reflection.ts:597-649) is a three-branch stat/compare/rewrite ladder over `flow.rawOutputBytes`, with a `logger.warn` "rewriting from the recorded offset" branch, and `restore` reads the file back at that offset (reflection.ts:444-455). A byte cursor is the imperative answer to replay safety.

The idempotent answer: write each response cycle to its own path keyed by the folded `continuationIndex`, and concatenate them in index order once, at the head of `produceOutput`, into the canonical `outputLocationFor(round)` that `processOutput` and `XmlOutputManager` already read. A re-entry rewrites the same path with the same bytes. `writeOutputFragment` collapses to one `fs.writeFileString`; the offset read-back deletes; `workspace.assembly.accumulatedOutput` on resume is the concatenation of the cycle files, which needs no directory enumeration because `continuationIndex` is folded state.

## 7. Resume

`loadRun` is the only place `start.resume` is read. After it, nothing branches on "is this a resume": the body is a switch on `state.phase` and `state.step`, which are folded facts, and it is the same function reading the same rows. Tool-use's park test (toolUse.ts:729-734) and `replayCommitted` re-entry are already phase-driven. Reflection's `runRound` is already phase-driven (reflection.ts:1089-1096, 1298-1301); with `outputLocation`, `endTurn` and `currentRound` recomputed and the round map read off the fold, `restore` shrinks to rebuilding `workspace` from `workspaceSnapshot`, hydrating `outputState.rounds` from `state.output`, and reading back `compileFailureContext` / `unresolvedCompileRejection`.

The residual process-local facts after this design, named so they are not rediscovered: the host's live control surface (`compactionRequested`, the attachment), which is a live request and correctly dies with the process; and tool-use's intra-turn tactics in `runTurn` (`forcedTool`, `finalToolAttempted`, `continuedAt`, `replayCommitted`), which reset per turn and whose replay semantics the loop already reasons about explicitly. Both belong in the file headers.

## 8. Relationship to PR #12767

#12767 (a533be2896, 4fe6cc7c21; 4 files, +64/-58) extracts `haltRun(runId, ledger, logger, state, coordinatesOf, outcome)` and `runExitFailure` into `loop/exitProtocol.ts` as helpers each loop calls. `runExitFailure` is right and survives inside `stoppedBy`. `haltRun`'s `coordinatesOf` resolver is the wrong shape: it parameterises over an asymmetry that should not exist, since it exists only to feed reflection's `coordinates` closure, which dies with `flow.currentRound`. Land #12767 if it is already green, because it shrinks what the tranche-4 rebase carries; then `exitProtocol.ts` is absorbed into `runProgram.ts` and the file deletes. Do not preserve `coordinatesOf`, and do not let both land as separate shared modules.

## Primitives

- Effect.acquireUseRelease(acquire, use, release) as the run: verified verbatim at node_modules/effect/dist/internal/effect.js:1872 and node_modules/effect/src/internal/effect.ts:4346-4358 as uninterruptibleMask(restore => flatMap(acquire, a => onExitPrimitive(suspend(() => restore(use(a))), exit => release(a, exit), true))). Gives an uninterruptible acquire, an uninterruptible release holding the body's TYPED Exit, and release-only-if-acquired, which is what deletes the `state === null || state.phase === null` guard both halts repeat (toolUse.ts:892-894, reflection.ts:1320-1322) and the hand-written Effect.uninterruptible wrapping both finalizers (toolUse.ts:887, reflection.ts:1316).
- Effect.acquireUseRelease again, at turn/round scale, for the trace stage. NOT Effect.scoped + Effect.acquireRelease: a Scope's finalizer receives Exit<unknown, unknown>, which is exactly why reflection keeps `let roundOutcome` (reflection.ts:1062) and prefers it over the exit at :1077-1084, and why toolUse uses try/finally with `let stageOutcome` (toolUse.ts:484, 687-690). The typed exit deletes both mutables. Answer to 'a Scope per turn': no, the turn owns no other releasable resource.
- Ref (one per run, inside RunCell) with the read-append-write as ONE Effect.uninterruptible region: Ref.get(ref).pipe(Effect.flatMap(s => ledger.appendBatch(runId, s, rows)), Effect.tap(next => Ref.set(ref, next)), Effect.uninterruptible). NOT SynchronizedRef: one fiber owns a run, so a lock is bought against no contention. This closes the stale-cell window (13 of the 14 loop appendBatch sites are unwrapped today) and subsumes the nine hand-written wrappers at ModelInvoker.ts:536,596,727,1025,1108,1126,1241, toolUseDispatch.ts:283 and reflection.ts:1125.
- Exit.match for the verdict, with Cause.hasInterruptsOnly (node_modules/effect/src/Cause.ts:624) NOT Cause.hasInterrupts (:1060). Effect's own doc at :1053 says hasInterruptsOnly is true 'only when _all_ reasons are interrupts'; both loops use the wider predicate today (toolUse.ts:921, reflection.ts:1336), so a run that failed and was then interrupted while unwinding is recorded CANCELLED.
- A discriminated union (RunEntry: 'fresh' | 'restored', both arms carrying `loaded`) as the shared entry contract, and a shared RunExit whose `outcome: RunOutcome | null` makes the park a value rather than a verdict callback. Data, not a record of open/restore/seed/verdict hooks: CLAUDE.md forbids a services bag, and a hook record is one in costume.
- Effect.gen + for(;;) as the loop. Effect.iterate, Effect.loop and Effect.tailRec are all `undefined` in the installed effect 4.0.0-rc.115 (probed); Effect.whileLoop takes a state-free LazyArg<boolean> predicate and a void-returning step, so threading RunState through it needs an external mutable cell, which is what this design deletes.
- REJECTED: Stream.unfold. A stream's completion carries no value, so the exit verdict would be reconstructed outside it; nothing consumes turns as elements; it adds a channel, a sink and a drain over a loop whose state already lives in the ledger, and deletes nothing.
- REJECTED: a Deferred or latch as an output-publication barrier. Once the three output facts ride the loop's ledger batch there is nothing to barrier; toolUse's session.settlePublications (toolUse.ts:819) stays for its transcript rows, which are a different channel.
- REJECTED: FiberMap / FiberSet / a per-turn Scope for ownership. A run is one fiber; there is nothing to own.
- Typed `lease: FollowUps | null` on settleRun, NOT Effect.serviceOption. An absent lease is a fact about the family, checked at the call site; an optional-service lookup would let a missing FollowUps leak a lease with nothing saying so, which is the silent-degradation shape.
- Effect.fn for every named step, as both files already use, so the trace spans survive the collapse.
- Zod discriminated-union shrink (FlowSnapshotPayloadSchema's two `state` arms) as the only snapshot vocabulary change. Both arms are z.object, which strips unknown keys (runFlowState.ts:283-286 states this deliberately), so the shrink would parse a stale row with its fields silently dropped: that is the .catch-on-persisted-data failure mode in another costume, which is why the format bump is not optional.

## Deletes

- src/agent/runtime/loop/toolUse.ts:144-146 `latest` (Ref.make<RunState|null>) and `commit` — 12 call sites, all in that file; replaced by RunCell.
- src/agent/runtime/loop/reflection.ts:284-286 `latest` and `commit` — 10 call sites, all in that file; replaced by RunCell.
- src/agent/runtime/loop/toolUse.ts:407-415 `fresh` and src/agent/runtime/loop/reflection.ts:376-384 `fresh` — one caller each (openFresh in each file); absorbed into loadRun's fresh arm.
- src/agent/runtime/loop/toolUse.ts:706-726 and src/agent/runtime/loop/reflection.ts:1173-1191, the resume-refusal block including its #11313 comment — one copy in loadRun.
- src/agent/runtime/loop/toolUse.ts:886-933 `finalize` and src/agent/runtime/loop/reflection.ts:1315-1341 `finalize` — sole callers are the Effect.onExit at toolUse.ts:947 and reflection.ts:1353; replaced by settleRun as acquireUseRelease's release arm.
- src/agent/runtime/loop/toolUse.ts:936-945 `failure` and src/agent/runtime/loop/reflection.ts:1344-1351 `failure`, plus the Effect.catchCause bodies at toolUse.ts:953-958 and reflection.ts:1355-1360 — replaced by stoppedBy(logger, label).
- src/agent/runtime/loop/toolUse.ts:446-453 `usageSnapshot` and src/agent/runtime/loop/reflection.ts:329-336 `usageSnapshot` — callers are the per-turn/per-round UsageMonitor.recordUsage calls; deleted with AgentRunStateSnapshotSchema.
- src/agent/runtime/loop/toolUse.ts:150 and :425-426 and :669, and src/agent/runtime/loop/reflection.ts:304 and :335 and :1144-1145 — the two hand-rolled `totalResponseTimeMs` accumulators; replaced by RunUsageTotals.totalResponseTimeMs in the fold.
- src/agent/runtime/loop/toolUse.ts:152 `let lastError` and src/agent/runtime/loop/reflection.ts:291 `let lastError` — readers are the two snapshot closures, toolUse.ts:735 `afterError`, reflection.ts:354-358 `resolveOutcome` and :361, and both result builders; RunState.lastError is the owner and buildSnapshot (rows.ts:183-189) already carries it forward.
- src/agent/runtime/loop/toolUse.ts:187-196 `snapshot` and src/agent/runtime/loop/reflection.ts:314-320 `snapshot` — their whole job was splicing `state: flowState(...)` and `lastError` into every patch.
- src/agent/runtime/loop/toolUse.ts:157-183 `flowState` and src/agent/runtime/loop/reflection.ts:309-313 `flowState` — sole callers are the two `snapshot` closures and the two `openFresh` bodies.
- src/agent/runtime/loop/reflection.ts:321-327 `coordinates` — callers at :586, :818, :827-828, :1236, :1254 and :1324; every one passes the folded state instead. Deleting it also fixes the halt row carrying a round the fold has not reached (enterRound mutates flow.currentRound at :1227-1232 before its batch commits at :1236-1241).
- src/agent/runtime/loop/toolUse.ts:484 `let stageOutcome` and :687-690 the `finally { stage.end(stageOutcome) }`, and src/agent/runtime/loop/reflection.ts:1062 `let roundOutcome` with the `roundOutcome ??` fallback at :1077-1084 — replaced by stagedBy, whose release reads the body's typed Exit.
- src/agent/runtime/loop/rows.ts:223-232 `snapshotRow` and :235-244 `reflectionSnapshotRow` — callers toolUse.ts:191 and :393, toolUseDispatch.ts:685 and :989, reflection.ts:318 and :402; both collapse into runtimeSnapshotRow (rows.ts:251-265), renamed `snapshotRow`. `buildSnapshot` (rows.ts:155-216) stops being a private indirection and becomes that function's body.
- src/agent/runtime/loop/rows.ts:45-54 `toolUseFlowState` / `reflectionFlowState` — callers toolUse.ts:158 and :418, reflection.ts:420, toolUseDispatch.ts:305; one `familyState(state, family)`. The `flow.state.modelId` term of the model-id fallback (rows.ts:165-168) goes with the field it reads.
- src/agent/runtime/loop/exitProtocol.ts (PR #12767, a533be2896) with `haltRun` and its `coordinatesOf` resolver parameter — absorbed into runProgram.ts; `runExitFailure` survives inside `stoppedBy`.
- src/shared/schemas/runFlowState.ts:80-83 `PersistedUsageAccumulatorSchema` and :84-88 `AgentRunStateSnapshotSchema`, whole. Consumers: runLedgerEvent.ts:544, runFlowState.ts:270 and :317, toolUse.ts:39 and :450, reflection.ts:91 and :333, UsageMonitor.ts:4/111/161/197/241.
- src/shared/schemas/runLedgerEvent.ts:544-546 `LedgerRunStateSnapshotSchema` and both `.extend({ runStateSnapshot })` splices (runLedgerEvent.ts:559-561 and :570-572 on main; :558-562 and :568-570 on the tranche-4 branch).
- src/shared/schemas/runFlowState.ts:292-295 `ToolUseSnapshotStateSchema.modelId` and `.modelCompatibilityKey` (duplicates of the required runtime fields; modelId's only reader is rows.ts:168), :296 `.shouldSkipCycle` (sole production writer toolUse.ts:164, zero production readers), and :270 `StateSlicesSchema.runStateSnapshot`.
- src/shared/schemas/runFlowState.ts ReflectionSnapshotStateSchema fields: :311 `currentRound` (duplicates runtime.round; the one reader outside the loop is packages/cli/src/runtime/toolUseResumeData.ts:46, which reads snapshot.runtime.round instead), :315 `outputLocation` (pure outputLocationFor(round), reflection.ts:260-263), :317 `runStateSnapshot`, :319 `roundOutputs`, :321 `continueRounds` (initialised true at reflection.ts:306, read at :361 and :1271, never assigned false in production), :322 `endTurn` (finishReasonOf(state.lastTurn), reflection.ts:756), :326 `modelCompatibilityKey` (never set by reflection's flow literal at :300-308), :339 `rawOutputBytes`. `totalRounds` (:312) STAYS: it is the round budget, no row carries it, and toolUseResumeData.ts:47 reads it.
- src/shared/session/runStateFold.ts:253 `'run.fact': true` in IGNORED_ROW_TYPES (tranche-4: :215) — the record is a compile-checked total map (:242-244), so removal forces the arm to be classified.
- src/agent/implementations/flows/reflection/output/outputState.ts:59-63 `roundsFromPersisted` and :65-78 `roundsToPersisted` — callers reflection.ts:312, :436 and :1301, plus the roundOutputs snapshot field. Deleting them also disposes of the sparse-array defect the second function's own doc describes against a z.array target.
- src/agent/implementations/flows/reflection/output/outputState.ts:138-152 `publishMissingOutputs`'s AgentTrace parameter and its trace.emit — callers outputValidation.ts:64 and reportMissingOutputs (:163-179); it returns the draft for the loop to append.
- src/agent/runtime/loop/reflection.ts:957-960 and :966-969, the two `logger.emit({ type: 'run.fact' })` calls — become returned drafts on the loop's batch.
- src/agent/runtime/loop/reflection.ts:597-649 `writeOutputFragment`'s three stat/compare/rewrite branches and the `rewriting from the recorded offset` warn, and :444-455 the offset read-back in restore — replaced by per-cycle files keyed by continuationIndex.
- src/shared/schemas/output.ts:265 `RoundOutputSchema.rawOutput` — four writers (outputFileExtraction.ts:132, roundSummary.ts:45, outputState.ts:88, reflection.ts:933), zero readers under `rg -n "rawOutput" src packages -g '*.ts'` outside a doc comment at roundIndexed.ts:10.
- The proposed `output.produced` row type, its payload schema and its listing entry: never added. See rulings.

## Adds

- src/agent/runtime/loop/runProgram.ts — six values and three types: `RunCell` + `makeRunCell(runId, opened)`, `RunEntry` + `loadRun(runId, family, resume)`, `RunExit`, `settleRun(cell, logger, lease)`, `stoppedBy(logger, label)`, `stagedBy(open, outcomeOf)`. Two callers each, so check:dead-code-ratchet is satisfied in the same PR. No callback record, no family parameter on the loop.
- The family check on resume, one line inside loadRun, closing the tool-use hole at toolUse.ts:417-419 (a reflection run resumed as tool-use continues silently with an empty workspace, where reflection.ts:421-425 fails loudly).
- The correlation guard in the single snapshotRow: `if (state.family !== null && patch.state !== undefined && state.family !== patch.state.family) throw` — one line closing a hole the two-wrapper design left open.
- `OutputFactDraft` in src/shared/session/runStateFold.ts: `Omit<Extract<SessionEventDraft,{type:'run.fact'}>,'fact'> & { readonly fact: Extract<RunFact,{key:'outputFiles'|'compileFailures'|'missingOutputs'}> }`, added as an arm of RunLedgerDraft. Spelled this way because the one-step Extract resolves to never (the draft's `fact` is the whole five-arm RunFactSchema, sessionEvent.ts:348 over rowValues.ts:29-44).
- One `run.fact` arm in src/shared/session/runRows.ts (post-rebase; runStateFold.ts pre-rebase), latest-wins per key, projecting onto a new `RunState.output` (three RoundIndexed maps) for the loop and onto sessionFold's existing files/outputs/compileFailures/missingOutputs for the view. `todos` and `plan` stay display-only in sessionFold.
- `RunUsageTotalsSchema.totalResponseTimeMs: z.number().nonnegative().prefault(0)` (src/shared/schemas/usage.ts:141-152), accumulated in the fold from each `response` row's NormalizedUsage.responseTimeMs (runFlowState.ts:49). EMPTY_RUN_USAGE_TOTALS picks it up for free.
- `'context-window'` added to ModelCompactionPayloadSchema.cause, and `RunState.overflowRecoveredAtRound: number | null` folded from that row — the durable, derived home of reflection.ts:297 `contextWindowRecoveryAttempted`, and it stops compaction.ts:302 spelling a forced overflow compaction the same as a threshold one.
- Per-cycle raw-output paths keyed by the folded continuationIndex, concatenated in index order once at the head of produceOutput into the canonical outputLocationFor(round) that processOutput and XmlOutputManager already read.
- One SESSION_EVENT_FORMAT bump, shared with the tranche-4 lane's 8 (main is 7 at sessionEvent.ts:588; int/snapshot-and-one-fold-0921d is already 8 at :592 with its fingerprint repinned by 4c31f74626). If tranche-4 has merged, bump once to 9; never two bumps for one release.

## Steps

0. Rebase onto int/snapshot-and-one-fold-0921d (or wait for it to merge). That branch has already rewritten runStateFold.ts by -378 lines, created runRows.ts (2896c7e58c, 'one reducer for the rows both folds read'), rewritten buildSnapshot in rows.ts, and repinned the session-event format fingerprint at 8 (4c31f74626). Every line number below that names runStateFold.ts or rows.ts shifts; the run.fact fold arm lands in runRows.ts, not runStateFold.ts. Also land PR #12767 first if it is already green (it is behaviour-preserving and shrinks what this rebase carries); its exitProtocol.ts is deleted in step 1.
   files: src/shared/session/runRows.ts, src/shared/session/runStateFold.ts, src/agent/runtime/loop/rows.ts, src/shared/schemas/sessionEvent.ts
1. PR-A, the scaffolding collapse, behaviour-preserving except for the two named fixes. Add runProgram.ts with makeRunCell/loadRun/settleRun/stoppedBy/stagedBy and the RunEntry and RunExit types; delete exitProtocol.ts. Rewrite both loops' entry as loadRun + a two-arm branch, and both tails as Effect.acquireUseRelease(enter, loopBody, settleRun) inside stoppedBy, with tool-use's attachment as its own outer bracket. Replace all 14 commit/appendBatch pairs with cell.append and every service-returned state with cell.adopt. Convert toolUse's try/finally stage and reflection's scoped acquireRelease stage to stagedBy. Collapse rows.ts's three snapshot constructors to one and toolUseFlowState/reflectionFlowState to familyState; delete coordinates and pass the folded state at all seven sites; delete both let lastError mirrors and both snapshot/flowState closures. Two behaviour changes to state in the PR body: every ledger append is now uninterruptible (a stop waits for the in-flight SQLite write plus its inbox job), and Cause.hasInterruptsOnly moves a run that failed and was then interrupted from CANCELLED to FAILED, which reaches deriveRunOutcome consumers.
   files: src/agent/runtime/loop/runProgram.ts, src/agent/runtime/loop/exitProtocol.ts, src/agent/runtime/loop/toolUse.ts, src/agent/runtime/loop/reflection.ts, src/agent/runtime/loop/rows.ts, src/agent/runtime/loop/toolUseDispatch.ts, src/agent/runtime/ModelInvoker.ts, src/agent/runtime/FollowUps.ts, config/ratchets/file-size-baseline.json
2. PR-B, the raw output becomes idempotent by coordinate. Write each response cycle to its own path keyed by the folded continuationIndex; concatenate in index order at the head of produceOutput into the canonical outputLocationFor(round); delete writeOutputFragment's stat/compare/rewrite ladder and the offset read-back in restore; stop writing flow.rawOutputBytes (the field is already .optional() at runFlowState.ts:339, so not writing it is legal and needs no bump; it is deleted in PR-C). Confirm nothing in the CLI or desktop surfaces a per-round raw path by name before landing, since this changes the on-disk layout under .texra.
   files: src/agent/runtime/loop/reflection.ts
3. PR-C, the persisted vocabulary shrink and reflection output as rows. This PR carries the single format bump. (a) Add RunUsageTotals.totalResponseTimeMs and fold it from each response row; delete AgentRunStateSnapshotSchema, PersistedUsageAccumulatorSchema, LedgerRunStateSnapshotSchema, both .extend splices, both usageSnapshot closures and both accumulators; change UsageMonitor.recordUsage to take RunState. (b) Delete the twelve dead or derivable snapshot fields listed in the deletes; keep totalRounds; recompute outputLocation, endTurn and currentRound; fix packages/cli/src/runtime/toolUseResumeData.ts:46 to read snapshot.runtime.round. (c) Add OutputFactDraft to RunLedgerDraft, remove 'run.fact' from IGNORED_ROW_TYPES, add the latest-wins fold arm in runRows.ts and RunState.output; make publishOutput, produceOutput and publishMissingOutputs return drafts that enterRound and finish put at the head of their batch; keep the emitCompileFailures gate; hydrate outputState.rounds from state.output in restore; delete roundsToPersisted/roundsFromPersisted and RoundOutput.rawOutput. (d) Add 'context-window' to ModelCompactionPayloadSchema.cause and fold RunState.overflowRecoveredAtRound, replacing reflection's process-local contextWindowRecoveryAttempted. (e) Bump SESSION_EVENT_FORMAT once and regenerate the fingerprint snapshot. Test churn is fixture edits across roughly a dozen kernel suites (sessionFold, ResumeCommand, HistoryStatus, ToolUseResumeData, ExecuteCli, WorkflowRunCommand, SessionResumeRetrieval, completedRunArchive, ExecutionsToolResumability, ToolUseDispatchParallel, sessionEvents, followUp/ToolUseWait); edit them, do not add files. [FORMAT BUMP]
   Landed as (a), (b), (d) and (e), at SESSION_EVENT_FORMAT 12; `addTurnUsage` moved to `runFlowState.ts` beside `NormalizedUsage` to keep `runStateFold.ts` under its file-size budget. (c) is superseded, not taken: #13027 (dba36728d1) had already moved reflection output onto a folded `output.produced` row that the loop commits through its cell, and snapshots no longer restate the round collection. That contradicts this design's "no new row type" ruling, and it is the owner's ruling now, so `roundsToPersisted` survives as the row's writer.
   files: src/shared/schemas/usage.ts, src/shared/schemas/runFlowState.ts, src/shared/schemas/runLedgerEvent.ts, src/shared/schemas/output.ts, src/shared/schemas/sessionEvent.ts, src/shared/session/runRows.ts, src/shared/session/runStateFold.ts, src/shared/session/sessionFold.ts, src/agent/runtime/UsageMonitor.ts, src/agent/runtime/loop/reflection.ts, src/agent/runtime/loop/toolUse.ts, src/agent/runtime/loop/rows.ts, src/agent/runtime/run/compaction.ts, src/agent/implementations/flows/reflection/output/outputState.ts, src/agent/implementations/flows/reflection/output/outputFileExtraction.ts, src/agent/implementations/flows/reflection/output/roundSummary.ts, src/agent/runtime/executeAgent.ts, packages/cli/src/runtime/toolUseResumeData.ts, src/test-kernel/schemas/**snapshots**/sessionEventFormat.json
4. PR-D, the cell reaches the run services. Thread RunCell into ModelInvoker (invoke drops its state parameter) and toolUseDispatch (dispatchPendingResponse likewise), and delete the nine hand-written Effect.uninterruptible(appendBatch(...)) wrappers at ModelInvoker.ts:536, 596, 727, 1025, 1108, 1126, 1241, toolUseDispatch.ts:283 and reflection.ts:1125, which RunCell.append subsumes. This changes two public signatures with two callers each, so it stays its own PR.
   files: src/agent/runtime/ModelInvoker.ts, src/agent/runtime/loop/toolUseDispatch.ts, src/agent/runtime/loop/toolUse.ts, src/agent/runtime/loop/reflection.ts, src/agent/runtime/loop/runProgram.ts

## Rulings taken

- Recommended: model the run as a resource and use Effect.acquireUseRelease, not a project-local runProgram combinator over Effect.onExit. Verified at node_modules/effect/src/internal/effect.ts:4346-4358; it supplies the uninterruptible acquire, the typed-Exit release and release-only-if-acquired that both finalizers hand-roll.
- Recommended: no family-parameterised program and no spec object. The shared module exports values and total functions; each loop writes its own three-argument acquireUseRelease. A record of open/restore/seed/verdict/release callbacks is a services bag, which CLAUDE.md's 'There is no flow engine' rules out.
- Recommended: RunCell.append makes read-append-write one Effect.uninterruptible region. Naming the single writer is not enough; 13 of the 14 loop appendBatch sites are interruptible today, and the window between a durable commit and Ref.set is how the halt row's own appendBatch gets refused into a logger.warn.
- Recommended: Cause.hasInterruptsOnly, not Cause.hasInterrupts, in the verdict. node_modules/effect/src/Cause.ts:1053 states the distinction; the current predicate records an interrupted failure as CANCELLED.
- Recommended: no new output.produced row type. Extend RunLedgerDraft with a key-narrowed run.fact arm and fold it. Database.ts:162's LISTING_GROUP already carries the $.fact.key discriminator, listingKeyOf mirrors it at sessionEvent.ts:694-698, sessionFold.ts:1467-1481 already folds all three maps, and 7543bdc755 (#12912) is the owner's own consolidation of five row types into that one keyed row.
- Recommended: go to ONE snapshot constructor, not two. runtimeSnapshotRow is the general case (it already reads state.flow and already serves both families from four sites), so it is the survivor with an optional residual patch.state.
- Recommended: no Scope per turn. The turn's only releasable resource is the trace stage handle, and a Scope finalizer receives Exit<unknown, unknown>, which is exactly why both loops keep a mutable stage verdict. acquireUseRelease at turn scale deletes both.
- Recommended: keep ReflectionSnapshotState.totalRounds, delete currentRound, and fix packages/cli/src/runtime/toolUseResumeData.ts:46 to read snapshot.runtime.round. totalRounds is the round budget and no row carries it; currentRound duplicates runtime.round.
- Recommended: derive the overflow-recovery gate rather than persist a flag. Add 'context-window' to ModelCompactionPayloadSchema.cause and fold RunState.overflowRecoveredAtRound. R1 says nothing derived is persisted, and the transcript is dishonest today because compaction.ts:302 spells a forced overflow compaction the same as a threshold one.
- Recommended: delete the byte cursor rather than harden it. Per-cycle files keyed by the folded continuationIndex, concatenated once at produceOutput, make the write idempotent by coordinate and delete the stat/compare/rewrite ladder and the offset read-back.
- Recommended: keep the emitCompileFailures gate (reflection.ts:852/887/903/940/961). It is a real policy; a refactor lane must not silently widen what a run publishes.
- Recommended: land PR #12767 if green, then delete exitProtocol.ts and drop its coordinatesOf resolver, which exists only to accommodate reflection's coordinates closure and dies with flow.currentRound.
- Recommended: one format bump for the whole stack, riding the tranche-4 lane's 8. Two bumps for one release is a second forced store clear for every user.

## Refuted candidates touched

- None in config/ratchets/refuted-candidates.json. I read all thirteen entries: the four EFF-ADOPT rulings concern withPerKeyLane onto Semaphore, ModelRetryGate onto Schedule, src/tools/timeouts.ts, and jitteredExponentialBackoffMs; the six RT-* rulings concern CLI command lifting, the process runtime, resume-command shape, a corrupt-record tag, typed subscription-usage failures and the desktop PTY host; the two SCOPE-* rulings concern HeldSessions and ExternalRoots. This design proposes no Semaphore, no Schedule, no per-fiber retry, and no new service. All four are cited as .agents/docs/proposed/simplification/2026-09-20-effect-facility-adoption.md#3-not-re-proposed or 2026-09-20-service-scope-ownership-ledger.md#33-refuted-with-the-evidence; none applies.
- The output.produced row type is refused against 7543bdc755 ('refactor(session): one run.fact row, one stored-value row, a park row (#12912)'), the owner's own consolidation of five row types into one keyed row. Cite that commit, plus Database.ts:162 and sessionEvent.ts:694-698, wherever this design says the round map stays on run.fact. It is not in the refuted-candidates JSON, so any lane re-proposing it must argue against that commit with new evidence.
- The snapshot deletions cite .agents/docs/implemented/architecture/2026-09-10-one-run-model.md R1 (:73-86): 'nothing derived is persisted and nothing persisted is derived ... A snapshot that carries a fact no row carries is not a checkpoint, it is a second store ... that gap closes by giving those facts rows'. Section 5 of the same note (:468-473) confirms flow.snapshot itself stays as the admitted checkpoint, which is why runtime.phase/round/turn/continuationIndex are untouched here.
- Moving the host open-file and instruction actions relative to the output commit cites .agents/docs/implemented/architecture/2026-09-04-agent-runtime-on-effect.md:608, which rules those are best-effort, at-most-once notifications a crash may lose. This design does not reorder them, but PR-C touches publishOutput and a reviewer will ask.

## Concurrent lane guidance

ADJUST, do not stop. The tranche-4 lane (int/snapshot-and-one-fold-0921d) is correct and lands first; this design rebases onto it rather than beside it. Five adjustments, all cheaper before it merges than after. (1) Keep going on the runtime derivation, but do NOT invent a row-derivation for the family `state` object: most of it is being deleted, not derived, and a derivation written for roundOutputs, outputLocation, endTurn, currentRound, runStateSnapshot, continueRounds or shouldSkipCycle is thrown away in the same release. (2) Classify `run.fact` as a FOLDED arm, not an ignored one, and put the arm in runRows.ts, which is that file's stated charter ('one reducer for the rows both folds read', 2896c7e58c): today runStateFold ignores it at :253 while sessionFold folds it at :1467-1481, which is R1's named defect and is a prerequisite for this design, not a conflict. The split is by KEY, not by type: outputFiles/compileFailures/missingOutputs fold, todos/plan stay display-only. Use the Omit-plus-property spelling for the narrowing, because the one-step Extract resolves to never. (3) While rewriting buildSnapshot in rows.ts, collapse snapshotRow/reflectionSnapshotRow/runtimeSnapshotRow to one constructor there rather than leaving three faces of a function you have just shortened; runtimeSnapshotRow is the survivor. (4) Do NOT remove runtime.round/turn/continuationIndex or runtime.lastError from the snapshot: the Exit-driven halt row is authored from them, they become the sole owner of the round once reflection's flow.currentRound dies, and the loops are about to stop mirroring lastError into a local. (5) If you can take the twelve field deletions into the same edit that already rewrites the snapshot payload, do: the fingerprint should be pinned once, not twice. Otherwise leave them and this design's PR-C carries the one bump (to 9 if you have merged at 8). For the PR #12767 lane: land it if green, then rework to contribute runExitFailure alone into runProgram.ts; drop exitProtocol.ts as a file and drop the coordinatesOf resolver. For the liveness/interruption lane (int/liveness-interruption-residue-0921d): nothing here touches RunHandle or bindAbortSignals, but note that tool-use's detach now lives in an acquireUseRelease release arm, so do not also add a detach to the exit path. For any lane touching an append site: do not add another Effect.uninterruptible(ledger.appendBatch(...)) wrapper; there are nine and they all subsume into RunCell.append.

## Acceptance

- rg -n "Ref.make<RunState" src/agent/runtime/loop/toolUse.ts src/agent/runtime/loop/reflection.ts -> 0 hits (the cell lives once, in runProgram.ts)
- rg -n "Cause.hasInterrupts\b" src/agent/runtime/loop/ -> 0 hits; rg -n "hasInterruptsOnly" src/agent/runtime/loop/runProgram.ts -> at least 1
- rg -c "ledger.appendBatch" src/agent/runtime/loop/toolUse.ts src/agent/runtime/loop/reflection.ts -> 1 each (openFresh's opening batch only; every other write is cell.append)
- rg -n "Effect.uninterruptible" src/agent/runtime/ModelInvoker.ts src/agent/runtime/loop/toolUseDispatch.ts src/agent/runtime/loop/reflection.ts src/agent/runtime/loop/toolUse.ts -> 0 hits after PR-D; the only Effect.uninterruptible in the run path is inside RunCell.append
- rg -n "state === null \|\| state.phase === null" src/agent/runtime/loop/ -> 0 hits (acquire's postcondition replaced the guard)
- rg -n "stageOutcome|roundOutcome" src/agent/runtime/loop/ -> 0 hits; rg -n "} finally {" src/agent/runtime/loop/toolUse.ts -> 0 hits
- rg -n "reflectionSnapshotRow|runtimeSnapshotRow|toolUseFlowState|reflectionFlowState" src packages -> 0 hits (one snapshotRow, one familyState)
- rg -n "const coordinates" src/agent/runtime/loop/reflection.ts -> 0 hits
- rg -n "logger.emit\(\{" -A2 src/agent/runtime/loop/reflection.ts | rg "run.fact" -> 0 hits; rg -n "trace.emit" src/agent/implementations/flows/reflection/output/outputState.ts -> 0 hits
- rg -n "'run.fact': true" src/shared/session/runStateFold.ts -> 0 hits; rg -n "run.fact" src/shared/session/runRows.ts -> at least 1
- rg -n "shouldSkipCycle|continueRounds|roundOutputs|rawOutputBytes|currentRound|outputLocation:|endTurn:|runStateSnapshot" src/shared/schemas/runFlowState.ts -> 0 hits; rg -n "totalRounds" src/shared/schemas/runFlowState.ts -> 1 hit (the reflection round budget)
- rg -n "AgentRunStateSnapshotSchema|PersistedUsageAccumulatorSchema|LedgerRunStateSnapshotSchema" src packages -> 0 hits
- rg -n "totalResponseTimeMs" src/shared/schemas/usage.ts -> 1 hit; rg -n "let totalResponseTimeMs" src/agent/runtime/loop/ -> 0 hits
- rg -n "roundsToPersisted|roundsFromPersisted" src packages -> 0 hits; rg -n "rawOutput\b" src/shared/schemas/output.ts -> 0 hits
- rg -n "contextWindowRecoveryAttempted" src -> 0 hits; rg -n "'context-window'" src/shared/schemas/runLedgerEvent.ts src/agent/runtime/run/compaction.ts -> at least 2
- rg -n "toolUseFlowState\(state\); *$" -A1 src/agent/runtime/loop/toolUse.ts -> no `if (flow === null) return;` remains; rg -n "resume it as one" src/agent/runtime/loop/runProgram.ts -> 1 hit, shared by both families
- rg -n "state.currentRound" packages/cli/src/runtime/toolUseResumeData.ts -> 0 hits; rg -n "snapshot.runtime.round" packages/cli/src/runtime/toolUseResumeData.ts -> 1 hit
- git log --oneline -- src/shared/schemas/sessionEvent.ts | rg -c "SESSION_EVENT_FORMAT" across the stack -> exactly one bump commit for PR-A..PR-D combined
- rg -n "exitProtocol" src -> 0 hits; rg -n "coordinatesOf" src -> 0 hits
- npm run check:dead-code-ratchet passes with runProgram.ts's six exports each having two consumers in the same PR

## Open questions for owner
