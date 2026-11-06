/**
 * Await one native subagent child in band, for callers that consume a typed
 * result.
 *
 * The child runs under the same `childRunLoop` every detached delegation
 * drives, awaited: no delivery or notice reaches the parent, and this
 * caller reads its last turn; "in-band" is only this caller blocking on the
 * loop's completion, and XML presentation remains a delivery adapter. The
 * child's own run
 * aggregate is the durable record of what happened, so whether an earlier
 * child already answered a logical call belongs to whoever owns that call
 * identity (the `agent` tool derives the attempt's run id and probes it);
 * this module only ever starts the run it is handed.
 */

// Third-party imports
import { Cause, Clock, Effect, Exit, Fiber, Result, Schema } from 'effect';

// Local imports
import { getRunRecords, persistedParentRunId } from '@agent/storage/runRecords';
import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import type {
  AgentConfig,
  AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { checkpointRefusal } from '@agent/storage/resumability';
import {
  registryOf,
  Runs,
  type AgentRunServices,
} from '@agent/runtime/runRegistry';
import {
  createNativeSubagentStrategy,
  type ChildRunLaunchOptions,
} from '@agent/runtime/nativeSubagentStrategy';
import type { ApprovalGrants } from '@shared/approvalBypassKind';
import {
  AgentConfigSchema,
  RUN_OUTCOME,
  type RunEnd,
  type RunId,
  type RunParent,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { startDetachedChildRunLoop } from './detachedChildRun';

interface InBandSubagentRunBaseOptions extends ChildRunLaunchOptions {
  /** The launching run: a fresh child's parent edge, and the run its loop
   *  answers to. */
  readonly parentRunId: RunId;
  /** The run this attempt executes under; the caller owns its derivation. */
  readonly runId: RunId;
  /** The parent's call that launches the child, which owns it, and its
   *  tool card. */
  readonly parentCall?: NonNullable<RunParent['call']>;
  /** The grants a fresh child is registered with. */
  readonly grants?: ApprovalGrants;
  /**
   * Live progress sink for the in-band child. An in-band parent is mid-cycle,
   * so follow-up delivery cannot reach it; the caller projects progress onto
   * the parent run's trace instead. Absent means deliberately silent, not
   * accidentally dropped.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

interface InBandSubagentRunResult {
  readonly runId: RunId;
  readonly result: RunEnd;
}

/** A child launched fresh from its definition, or a persisted one resumed
 *  where it stopped under the run id it already has. */
type InBandLaunch =
  | {
      readonly kind: 'fresh';
      readonly definition: PreparedAgentDefinition;
    }
  | { readonly kind: 'resume'; readonly config: AgentConfig };

/** A defect as a failed `Error`; an interruption stays one. */
const defectsAsErrors = <A, R>(
  self: Effect.Effect<A, Error, R>,
): Effect.Effect<A, Error, R> =>
  self.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(ensureError(Cause.squash(cause))),
    ),
  );

/**
 * Execute one child through the one shared driver and read its typed result
 * back from the durable record. The child runs under the same child-run
 * loop every native child uses, awaited (no delivery or notice reaches the
 * parent); "in-band" is only this caller awaiting the loop's completion.
 * Once the run reaches its own terminal persistence, later caller
 * cancellation rejects the awaiting stage but never rewrites the record.
 *
 * No end, or no finished turn, fails with the loop's failure as the cause;
 * an end that says failed fails with the child's error. Any other end is
 * returned with the turn's output once its `run.result` manifest is read
 * back: the end can commit without it (a refused last turn leaves a
 * `result-lost` end alone, `finalizeRun`), and recovery reads the manifest
 * (`standingOf`), so a completion without one is refused here as there.
 *
 * A loop failure after the turn finished does not rewrite the outcome when the
 * child's rows were already committed: the committed rows are the fact, and a
 * claim release or ending that threw afterwards leaves them whole.
 */
const executeInBand = Effect.fn('executeInBand')(
  function* (
    options: InBandSubagentRunBaseOptions,
    launch: InBandLaunch,
  ): Effect.fn.Return<InBandSubagentRunResult, Error, AgentRunServices> {
    const { runId } = options;
    const config =
      launch.kind === 'fresh' ? launch.definition.config : launch.config;
    const startedAt = yield* Clock.currentTimeMillis;
    const workingDirectory = config.workingDirectory ?? undefined;
    const { fiber, lastTurn } = yield* startDetachedChildRunLoop({
      runId,
      parentRunId: options.parentRunId,
      agentName: config.agent,
      // Its parent is blocked awaiting it, so it rides the parent's slot.
      awaited: true,
      ...(options.notify !== undefined && { notify: options.notify }),
      strategy: createNativeSubagentStrategy({
        ...options,
        ...(launch.kind === 'fresh'
          ? {
              definition: launch.definition,
              // Registered with its opening, which its run commits.
              registration: {
                identity: { kind: 'agent', agent: config.agent },
                parentRunId: options.parentRunId,
                parentCall: options.parentCall,
                grants: options.grants,
              },
            }
          : // Awaited: it ends after one cycle, resumed too.
            {
              resume: {
                config,
                parent: persistedParentRunId(runId),
                stopAfterCycle: true,
              },
            }),
        runId,
        startedAt,
        workingDirectory,
      }),
    });

    const completionExit = yield* Effect.exit(Fiber.join(fiber));
    // The turn the child ended with, as its loop recorded it, and this
    // activation's end (null while it has none).
    const finished = lastTurn();
    const resultMeta = finished?.resultMeta;
    const ended = yield* Effect.result(getRunRecords(runId).readRunEnd());
    const runEnd = Result.isSuccess(ended) ? ended.success : null;
    if (
      finished === undefined ||
      resultMeta?.producer !== 'subagent' ||
      runEnd === null
    ) {
      // Why: the read's failure, else the loop's, else what the turn threw.
      let cause: unknown = finished?.error;
      if (Result.isFailure(ended)) cause = ended.failure;
      else if (Exit.isFailure(completionExit))
        cause = Cause.squash(completionExit.cause);
      return yield* Effect.fail(
        new Error(
          `Subagent ${runId} ended without a recorded result${cause === undefined ? '' : `: ${toErrorMessage(cause)}`}`,
          { cause },
        ),
      );
    }
    if (finished.isError || runEnd.outcome === RUN_OUTCOME.FAILED)
      return yield* Effect.fail(
        ensureError(
          finished.error ??
            new Error(
              runEnd.error?.message ??
                `Subagent ${runId} ended with failed outcome.`,
            ),
        ),
      );

    if ((yield* getRunRecords(runId).readResultMeta())?.producer !== 'subagent')
      return yield* Effect.fail(
        new Error(
          `Subagent ${runId} ended, but its result was not recorded. Its work may be done: check before calling it again.`,
        ),
      );

    // A caller stop landing here interrupts the join, not the child: the
    // child's rows were committed under its own claim and the
    // detached loop owns its terminal record.
    return { runId, result: { ...runEnd, output: resultMeta.output } };
  },
  // Interruptible: the registration is one durable commit and the detached
  // loop owns the child from its first tick, so an interruption lands in the
  // join or the read-back and leaves the same rows a crash would.
  defectsAsErrors,
);

/**
 * Launch one child under the run id its caller derived and read the typed
 * result back from the durable record. Recovering an earlier attempt belongs
 * to the caller that owns the call identity; this only ever starts a new run.
 *
 * The caller cancels by interruption, and the child's loop is a detached
 * fiber that interruption does not reach, so this is the edge between the
 * two: interrupting the caller stops the child by run id — the loop's own
 * stop, which interrupts the child run's fiber — then waits for the child to
 * write its own terminal record. A launch that has no live run yet is
 * interrupted where it is; one whose loop started inside the launch's
 * uninterruptible hand-off is stopped once that hand-off returns.
 */
export const executeSubagentInBand = (
  options: InBandSubagentRunBaseOptions & {
    readonly configPayload: AgentConfigPayload;
  },
): Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices> =>
  awaitInBand(
    options.runId,
    Effect.gen(function* () {
      const definition = yield* prepareAgentDefinition({
        config: Schema.decodeUnknownSync(AgentConfigSchema)(
          options.configPayload,
        ),
        stopAfterCycle: true,
      });
      return yield* executeInBand(options, { kind: 'fresh', definition });
    }).pipe(defectsAsErrors),
  );

/**
 * Resume a persisted child under the run id it already has and await it as
 * {@link executeSubagentInBand} awaits a launch: the child continues where
 * its last owner stopped, in one cycle, and its typed result is read back
 * from the record. A child this process cannot resume (`checkpointRefusal`) is
 * refused first; one it can runs under its stored configuration.
 */
export const resumeSubagentInBand = (
  options: InBandSubagentRunBaseOptions,
): Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices> =>
  awaitInBand(
    options.runId,
    Effect.gen(function* () {
      const rejection = yield* checkpointRefusal(options.runId);
      if (rejection !== null)
        return yield* Effect.fail(
          new Error(
            `Subagent ${options.runId} cannot be resumed here (${rejection.kind}).`,
          ),
        );
      const config = yield* getRunRecords(options.runId).readConfig();
      if (config === null)
        return yield* Effect.fail(
          new Error(
            `Subagent ${options.runId} has no stored configuration to resume.`,
          ),
        );
      return yield* executeInBand(options, { kind: 'resume', config });
    }).pipe(defectsAsErrors),
  );

/** Await one in-band child's program; interrupting the caller stops the
 *  child by its run id and waits for it to write its own record, unless the
 *  caller's stop detached it (`RunRegistry.stop`): it runs on as a root, and
 *  only this wait ends. */
const awaitInBand = Effect.fn('inBandSubagentRun.awaitInBand')(function* (
  runId: RunId,
  program: Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices>,
): Effect.fn.Return<InBandSubagentRunResult, Error, AgentRunServices> {
  const runs = registryOf(yield* Runs);
  const child = yield* Effect.forkChild(program, { startImmediately: true });
  return yield* Fiber.join(child).pipe(
    Effect.onInterrupt(() =>
      Effect.suspend(() => {
        // A child the registry holds with no parent edge was detached: it
        // runs on as a root. One it does not hold yet is stopped below.
        if (
          runs.get(runId) !== undefined &&
          runs.attachedParent(runId) === null
        )
          return Effect.void;
        if (runs.interrupt(runId)) return Fiber.await(child);
        // No run to stop yet: a loop the launch's hand-off started meanwhile
        // is stopped once it returns, and awaited to the end.
        return Fiber.interrupt(child).pipe(
          Effect.andThen(Effect.sync(() => runs.interrupt(runId))),
          Effect.andThen(runs.awaitDrained(runId)),
        );
      }),
    ),
  );
});
