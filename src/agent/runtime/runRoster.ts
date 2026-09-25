/**
 * What this process holds for a run, in one entry per run: the fiber running
 * it, the tracked handle, the native child loop's activation and the run's
 * serial lane. One roster per session is the single in-process authority for
 * "is a generation of this run live here" ({@link RunRoster.isLive}), so
 * admission, stop and deletion answer from one record. The registry
 * (`runRegistry.ts`) owns the session-facing surface, the stopper
 * (`runStopping.ts`) what a stop does with these records. Serialization is
 * `withPerKeyLane`: FIFO admission with an interruptible wait, its lane kept
 * on the entry.
 */

import {
  Data,
  Deferred,
  Effect,
  Fiber,
  Latch,
  PubSub,
  type Scope,
} from 'effect';

import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import type { RunHandle } from './RunHandle';
import type { ChildRunActivation } from './runRegistryTypes';

/** A generation, a hold or a retained owner already has the run here: the one
 *  refusal for that fact. Hosts word it from `message`; a resume reads the tag
 *  to report the run unresumable, not failed. */
export class RunLive extends Data.TaggedError('RunLive')<{
  readonly runId: string;
}> {
  override get message(): string {
    return `Run is already running: ${this.runId}`;
  }
}

type AnyFiber = Fiber.Fiber<unknown, unknown>;
/** Everything this process holds for one run. The entry exists exactly while
 *  one of its fields does, which is what makes it the liveness authority. */
interface RunEntry {
  /** The fiber running this run here — its liveness, stop target and terminal
   *  owner — written by that fiber's first step, erased by its own exit. */
  fiber?: AnyFiber;
  hold?: AnyFiber;
  handle?: RunHandle;
  activation?: ChildRunActivation;
  /** The run's hand-off chain while a fiber holds or waits on it. */
  lane?: PerKeyLane;
  /** Fibers of this run holding or waiting on that lane; an inactive-run
   *  step takes the lane without being one ({@link RunRoster.isLive}). */
  launches: number;
}

export class RunRoster {
  private readonly entries = new Map<RunId, RunEntry>();
  /** Every change a waiter can wake on ({@link waitForAnyChange}), apart from
   *  the entries; opened by the first waiter, unbounded so publish never blocks. */
  private changes: PubSub.PubSub<RunId> | undefined;
  /** The stops begun for each run ({@link beginStop}), one token apiece, so
   *  of two overlapping stops the first to settle cannot admit a child the
   *  second's snapshot already left behind. */
  private readonly stopping = new Map<RunId, Set<symbol>>();
  /** Steps admitted but not yet started, across every run: session disposal
   *  fails all of them at once, so they need no per-run keying. */
  private readonly waiting = new Set<Deferred.Deferred<never, Error>>();
  /** The lane slots `withPerKeyLane` reads and writes: this roster's entries,
   *  so a lane is never a record of a run the entry map does not have. */
  private readonly lanes = {
    get: (runId: RunId) => this.entries.get(runId)?.lane,
    set: (runId: RunId, lane: PerKeyLane) => {
      this.entryFor(runId).lane = lane;
    },
    delete: (runId: RunId) => {
      const entry = this.entries.get(runId);
      if (!entry) return;
      entry.lane = undefined;
      this.prune(runId, entry);
    },
  };

  constructor(
    private readonly approvals: SessionApprovals,
    /** Admit one run's DB claim, for a hold that fences the claim together
     *  with the in-process owner ({@link holdInactive}). */
    private readonly claimRun?: (
      runId: RunId,
    ) => Effect.Effect<Effect.Effect<void, Error>, Error>,
  ) {}

  private entryFor(runId: RunId): RunEntry {
    const existing = this.entries.get(runId);
    if (existing) return existing;
    const entry: RunEntry = { launches: 0 };
    this.entries.set(runId, entry);
    return entry;
  }

  /** Drop an entry that records nothing: the run is not here any more. */
  private prune(runId: RunId, entry: RunEntry): void {
    if (entry.fiber ?? entry.handle ?? entry.activation ?? entry.lane) return;
    if (entry.hold !== undefined || entry.launches > 0) return;
    if (this.entries.get(runId) === entry) {
      this.entries.delete(runId);
      this.notifyWaiters(runId);
    }
  }

  // ------------------------------------------------------------------ fiber

  /** Register a fiber in `slot` on its entry; its own exit erases it. */
  private setFiber(runId: RunId, fiber: AnyFiber, slot: 'fiber' | 'hold') {
    const entry = this.entryFor(runId);
    entry[slot] = fiber;
    fiber.addObserver(() => {
      if (entry[slot] === fiber) {
        entry[slot] = undefined;
        this.prune(runId, entry);
        this.notifyWaiters(runId);
      }
    });
  }

  /** The run's stop, by run id: interrupt the fiber the entry names. Sync,
   *  and answered straight away: the entry has a fiber or it does not. */
  interrupt(runId: RunId): boolean {
    const fiber = this.entries.get(runId)?.fiber;
    if (fiber === undefined) return false;
    fiber.interruptUnsafe();
    return true;
  }

  // ---------------------------------------------------------------- handles

  handle(runId: RunId): RunHandle | undefined {
    return this.entries.get(runId)?.handle;
  }

  allHandles(): RunHandle[] {
    const handles: RunHandle[] = [];
    for (const entry of this.entries.values())
      if (entry.handle) handles.push(entry.handle);
    return handles;
  }

  setHandle(handle: RunHandle): void {
    const entry = this.entryFor(handle.runId);
    handle.parentState =
      entry.activation?.parent ??
      entry.handle?.parentState ??
      handle.parentState;
    entry.handle = handle;
  }

  /** Remove a run handle and notify waiters; a run with no handle still
   *  wakes its waiters, since the call is the change they wait on. */
  deleteHandle(runId: RunId): void {
    const entry = this.entries.get(runId);
    if (entry) {
      entry.handle = undefined;
      this.prune(runId, entry);
    }
    this.notifyWaiters(runId);
  }

  /** Remove `handle` only if it is still the current registration. */
  deleteHandleIfCurrent(handle: RunHandle): boolean {
    if (this.handle(handle.runId) !== handle) return false;
    this.deleteHandle(handle.runId);
    return true;
  }

  // ------------------------------------------------------- child activations

  activation(runId: RunId): ChildRunActivation | undefined {
    return this.entries.get(runId)?.activation;
  }

  /** Retain a native child loop's lineage. */
  addActivation(activation: ChildRunActivation): void {
    const entry = this.entryFor(activation.runId);
    activation.parent = entry.handle?.parentState ?? activation.parent;
    entry.activation = activation;
  }

  removeActivation(runId: RunId, expected: ChildRunActivation): void {
    const entry = this.entries.get(runId);
    if (entry?.activation !== expected) return;
    entry.activation = undefined;
    this.prune(runId, entry);
    // The loop's last record is gone: a waiter on its settlement wakes.
    this.notifyWaiters(runId);
  }

  *activeChildActivations(parentRunId: RunId): Generator<ChildRunActivation> {
    for (const entry of this.entries.values()) {
      const activation = entry.activation;
      if (
        activation !== undefined &&
        activation.parent.current === parentRunId
      ) {
        yield activation;
      }
    }
  }

  /** The children one parent's detach covers. A Set, not an array: a child
   *  detached mid-turn has both a live handle and a ChildRunActivation
   *  under one runId, so both loops reach it and it is severed once. */
  childRunIds(parentRunId: RunId): readonly RunId[] {
    const childRunIds = new Set<RunId>();
    for (const activation of this.activeChildActivations(parentRunId))
      childRunIds.add(activation.runId);
    for (const handle of this.allHandles())
      if (handle.isOwnedBy(parentRunId)) childRunIds.add(handle.runId);
    return [...childRunIds];
  }

  hasActiveChildren(parentRunId: RunId): boolean {
    return this.childRunIds(parentRunId).length > 0;
  }

  /** Apply parent removal to local handles and approval ancestry without
   *  publishing, over children a durable detach already covers. */
  detachChildren(
    parentRunId: RunId,
    childRunIds: readonly RunId[] = this.childRunIds(parentRunId),
  ): void {
    for (const childRunId of childRunIds) {
      const entry = this.entries.get(childRunId);
      const parent = entry?.activation?.parent ?? entry?.handle?.parentState;
      if (parent?.current === parentRunId) parent.current = null;
      this.approvals.detachRunFromParent(childRunId);
    }
  }

  /** Whether any fiber holds or waits on `runId`'s lane, step or generation. */
  private isLaneOccupied(runId: RunId): boolean {
    return (this.entries.get(runId)?.lane?.fibers ?? 0) > 0;
  }

  /** A handle or a child activation this session still retains for `runId`. */
  private isRetained(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    return entry?.handle !== undefined || entry?.activation !== undefined;
  }

  /** Whether a child may be admitted under `parentRunId` now. A begun stop of
   *  the parent refuses a new child ({@link beginStop}); a child this roster
   *  already holds is not a new admission — a native child's activation and
   *  its live handles re-enter while the detach runs. */
  admitsChild(parentRunId: RunId, childRunId: RunId): boolean {
    return !this.isStopping(parentRunId) || this.isRetained(childRunId);
  }

  /** Runs with a live interrupt target: tracked handles and native child
   *  activations. A lane still releasing outlives both; the drain waits on it. */
  activeIds(): RunId[] {
    const ids: RunId[] = [];
    for (const [runId, entry] of this.entries)
      if (entry.handle !== undefined || entry.activation !== undefined)
        ids.push(runId);
    return ids;
  }

  // ---------------------------------------------------------------- liveness

  /** Whether this process holds a live generation of the run: its fiber, an
   *  admitted launch, or a live tool-use flow on its handle. */
  isLive(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined) return false;
    if (entry.fiber ?? entry.hold ?? entry.launches > 0) return true;
    return entry.handle?.getToolUseFlow() !== undefined;
  }

  /** Run `operation` on `runId`'s lane: claim the lane synchronously, fork
   *  the operation registered on the entry from its first step, and hold
   *  the lane until that fiber settles, finalizers included.
   *
   *  The claim is conditional: {@link isLive} reads the entry in the same
   *  synchronous step as the tail swap, so this is the one admission.
   *  `refuseWhenLive` marks an inactive-run step rather than a generation: it
   *  also refuses on retained owners and lane holders, and stays out of
   *  {@link isLive}. A step waiting for its predecessor is refusable where it
   *  stands ({@link waiting}) and hands the lane on when interrupted. */
  launch<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
    refuseWhenLive = false,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      const refusal = Deferred.makeUnsafe<never, Error>();
      this.waiting.add(refusal);
      // Counted in where the generation claims the lane, out where the step leaves; the entry is captured at the claim, so a stale leave unwinding after `clear` decrements its own entry.
      let counted: RunEntry | undefined;
      const refuseClaim = (): RunLive | undefined => {
        const held =
          refuseWhenLive &&
          (this.isRetained(runId) || this.isLaneOccupied(runId));
        if (this.isLive(runId) || held) return new RunLive({ runId });
        if (refuseWhenLive) return undefined;
        // A new generation is the run starting again: whatever stop the run
        // was marked for belongs to the generation it ended.
        this.stopping.delete(runId);
        counted = this.entryFor(runId);
        counted.launches += 1;
        return undefined;
      };
      const leave = (): void => {
        this.waiting.delete(refusal);
        const entry = counted;
        counted = undefined;
        if (entry === undefined) return;
        entry.launches -= 1;
        this.prune(runId, entry);
      };
      const step = Effect.gen({ self: this }, function* () {
        this.waiting.delete(refusal);
        // The fiber registers itself as its first step (the forking fiber
        // may yield first), so a stop by run id reaches it from the first
        // instant; one only scheduled would skip its finalizers on a
        // pre-start interrupt. An inactive-run step is not a generation.
        const fiber = yield* Effect.forkChild(
          refuseWhenLive
            ? operation
            : Effect.withFiber((self) => {
                this.setFiber(runId, self, 'fiber');
                return operation;
              }),
          { startImmediately: true },
        );
        // An interrupted join interrupts the fiber and awaits its cleanup.
        return yield* Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        );
      });
      return Effect.raceFirst(
        Deferred.await(refusal),
        withPerKeyLane(this.lanes, runId, refuseClaim)(step),
      ).pipe(Effect.ensuring(Effect.sync(leave)));
    });
  }

  /** Hold `runId` against local ownership for the caller's scope, refusing
   *  as an inactive-run step does ({@link launch}). The hold is an idle fiber
   *  on the entry, which {@link isLive} reports and no stop reaches, and the
   *  run's DB claim rides its lifetime: one construct fences owner and claim. */
  holdInactive(
    runId: RunId,
  ): Effect.Effect<void, RunLive | Error, Scope.Scope> {
    return Effect.asVoid(
      Effect.acquireRelease(
        Effect.suspend(() => {
          // The test and the registration are one synchronous step, as the
          // conditional lane claim is: nothing can take the run in between.
          if (
            this.isLive(runId) ||
            this.isRetained(runId) ||
            this.isLaneOccupied(runId)
          )
            return Effect.fail(new RunLive({ runId }));
          return Effect.gen({ self: this }, function* () {
            const releaseClaim = this.claimRun
              ? yield* this.claimRun(runId)
              : undefined;
            const latch = yield* Latch.make(false);
            // Started at once, as `launch`'s is, so it always runs its release.
            const fiber = yield* Effect.forkChild(
              Latch.await(latch).pipe(
                Effect.ensuring(
                  releaseClaim === undefined
                    ? Effect.void
                    : releaseClaim.pipe(Effect.orDie),
                ),
              ),
              { startImmediately: true },
            );
            this.setFiber(runId, fiber, 'hold');
            return { latch, fiber };
          });
        }),
        // The join awaits the claim release before the caller's scope closes.
        ({ latch, fiber }) =>
          Latch.open(latch).pipe(Effect.andThen(Fiber.join(fiber))),
      ),
    );
  }

  // --------------------------------------------------------------- waiters

  notifyWaiters(runId: RunId): void {
    if (this.changes !== undefined) PubSub.publishUnsafe(this.changes, runId);
  }

  /**
   * Wait for any of `runIds` to change and succeed with the first that did.
   * The wake set: a status transition; a `track` (a replacement handle
   * included, so a waiter is not stranded across a resume); an `untrack`,
   * even of an id holding no handle; every `kill`; and session disposal. A
   * bounded wait races this effect: the subscription lives in its scope.
   */
  waitForAnyChange(runIds: readonly RunId[]): Effect.Effect<RunId> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        // Build first, then install without a yield in between: `??=` over a
        // `yield*` would read, suspend, and overwrite a hub a concurrent first
        // waiter already subscribed to. A losing fresh hub is dropped unread.
        const fresh = yield* PubSub.unbounded<RunId>();
        this.changes ??= fresh;
        const subscription = yield* PubSub.subscribe(this.changes);
        for (;;) {
          const changed = yield* PubSub.take(subscription);
          if (runIds.includes(changed)) return changed;
        }
      }),
    );
  }

  /** Resolve once every owner has left: each entry's fiber or hold by
   *  `Fiber.await`, then handles, activations and lanes through the hub. The
   *  re-check arm is load-bearing: `raceAllFirst` starts its arms in order,
   *  so a last run leaving before the subscription is still seen. */
  awaitDrained(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        const head = this.entries.values().next();
        if (head.done) return;
        const fiber = head.value.fiber ?? head.value.hold;
        if (fiber !== undefined) {
          yield* Fiber.await(fiber);
          continue;
        }
        const active = [...this.entries.keys()];
        if (active.length === 0) return;
        yield* Effect.raceAllFirst([
          this.waitForAnyChange(active).pipe(Effect.asVoid),
          Effect.suspend(() =>
            this.entries.size === 0 ? Effect.void : Effect.never,
          ),
        ]);
      }
    });
  }

  // ------------------------------------------------------------------ gates

  /** Mark a run's stop as begun, synchronously, before it reads which
   *  children to detach: a child admitted while the stop's `run.detach`
   *  commits would be in neither the durable nor the local sever. Until the
   *  stop settles ({@link throughStop}) no child is admitted under it
   *  ({@link admitsChild}). */
  beginStop(runId: RunId): symbol {
    const token = Symbol('run-stop');
    const tokens = this.stopping.get(runId) ?? new Set<symbol>();
    tokens.add(token);
    this.stopping.set(runId, tokens);
    return token;
  }

  /** End this stop's admission gate when its settlement does, succeeded or
   *  failed; the gate lifts when the last overlapping stop lets go. */
  throughStop(
    runId: RunId,
    token: symbol,
    settlement: Effect.Effect<void, Error>,
  ): Effect.Effect<void, Error> {
    return settlement.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const tokens = this.stopping.get(runId);
          if (tokens?.delete(token) !== true) return;
          if (tokens.size === 0) this.stopping.delete(runId);
        }),
      ),
    );
  }

  /** Whether a stop of `runId` has begun and not yet settled. */
  isStopping(runId: RunId): boolean {
    return this.stopping.has(runId);
  }

  // --------------------------------------------------------------- teardown

  /** Drop every local record at session disposal, refuse every step admitted
   *  but not started, and wake the waiters on every run the roster tracked. */
  clear(disposal: Error): void {
    for (const refusal of this.waiting) {
      Deferred.doneUnsafe(refusal, Effect.fail(disposal));
    }
    this.waiting.clear();
    const tracked = [...this.entries.keys()];
    this.entries.clear();
    for (const runId of tracked) this.notifyWaiters(runId);
    this.stopping.clear();
  }
}
