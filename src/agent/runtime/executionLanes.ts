/**
 * Lane scheduling for execution lifecycles.
 *
 * Owns the per-execution serial lanes that `ExecutionRegistry` runs lifecycle
 * steps through, so launch, resume, and delete of one execution id never
 * overlap while unrelated executions proceed in parallel.
 */

import pDefer from 'p-defer';
import PQueue from 'p-queue';

/**
 * The serial lifecycle lane of one execution id. Launch, resume, delete and
 * any other lifecycle step run through `queue` one at a time, and each step
 * first waits for `live`, the generation the last launch started, to dispose.
 * Generations of one execution therefore never coexist: a resume cannot mint
 * a lease while the previous run still holds one, and a delete cannot run
 * under a live run. Stop is a signal to the live generation, not a step.
 */
interface ExecutionLane {
  readonly queue: PQueue;
  live: Promise<void> | undefined;
  /** Steps admitted but not yet started; rejected if the session disposes. */
  readonly waiting: Set<(error: Error) => void>;
}

/** Resolve when `promise` settles either way; a lane waits, it never fails. */
function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * The per-execution lanes of one session's registry. A lane is created on
 * first use and forgotten once it drains, so idle executions hold no queue.
 */
export class ExecutionLanes {
  private readonly lanes = new Map<string, ExecutionLane>();

  /**
   * Run one lifecycle step of `executionId`; the lane stays held until the
   * step's own promise settles. See `ExecutionRegistry.runExecutionStep`.
   */
  enqueue<T>(executionId: string, step: () => Promise<T>): Promise<T> {
    return this.enqueueLaneStep(executionId, () => {
      const result = step();
      return { result, hold: result };
    });
  }

  /**
   * Launch a generation of `executionId`: its promise becomes the generation
   * later steps wait on. See `ExecutionRegistry.launchExecution`.
   */
  launch<T>(executionId: string, start: () => Promise<T>): Promise<T> {
    return this.enqueueLaneStep(executionId, (lane) => {
      const result = start();
      lane.live = settled(result);
      return { result, hold: undefined };
    });
  }

  /**
   * Chain `termination` onto the lane's live generation.
   *
   * The teardown releases the execution lease: it is the tail of the
   * suspended generation, so the lane waits for it before a resume can
   * claim the execution again.
   * A child loop's generation stays the lane's live promise until the loop
   * ends; the turn's teardown chains onto it rather than replacing it.
   */
  holdLive(executionId: string, termination: Promise<void>): void {
    const lane = this.laneFor(executionId);
    const previous = lane.live;
    lane.live = settled(
      previous ? Promise.all([previous, termination]) : termination,
    );
    this.forgetIdleLane(executionId, lane);
  }

  /** Refuse every admitted-but-unstarted step and drop all lanes. */
  disposeAll(error: Error): void {
    for (const lane of this.lanes.values()) {
      lane.queue.clear();
      for (const reject of lane.waiting) reject(error);
      lane.waiting.clear();
    }
    this.lanes.clear();
  }

  private enqueueLaneStep<T>(
    executionId: string,
    step: (lane: ExecutionLane) => {
      readonly result: Promise<T>;
      /** What the lane stays held for; `undefined` releases it at once. */
      readonly hold: Promise<unknown> | undefined;
    },
  ): Promise<T> {
    const lane = this.laneFor(executionId);
    const handedOut = pDefer<Promise<T>>();
    const settle: (result: Promise<T>) => void = handedOut.resolve;
    const { reject: refuse } = handedOut;
    lane.waiting.add(refuse);
    void lane.queue
      .add(async () => {
        await lane.live;
        // A disposal during the wait already refused this step.
        if (!lane.waiting.delete(refuse)) return;
        let run: ReturnType<typeof step>;
        try {
          run = step(lane);
        } catch (error) {
          settle(Promise.reject(error));
          return;
        }
        settle(run.result);
        if (run.hold) await settled(run.hold);
      })
      .finally(() => this.forgetIdleLane(executionId, lane));
    return handedOut.promise.then((result) => result);
  }

  private laneFor(executionId: string): ExecutionLane {
    let lane = this.lanes.get(executionId);
    if (!lane) {
      lane = {
        queue: new PQueue({ concurrency: 1 }),
        live: undefined,
        waiting: new Set(),
      };
      this.lanes.set(executionId, lane);
    }
    return lane;
  }

  private forgetIdleLane(executionId: string, lane: ExecutionLane): void {
    if (lane.queue.size !== 0 || lane.queue.pending !== 0) return;
    if (this.lanes.get(executionId) !== lane) return;
    const live = lane.live;
    if (live === undefined) {
      this.lanes.delete(executionId);
      return;
    }
    void live.then(() => {
      if (lane.live !== live) return;
      lane.live = undefined;
      this.forgetIdleLane(executionId, lane);
    });
  }
}
