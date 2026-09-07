/**
 * In-band native subagent execution for callers that consume a typed result.
 *
 * This is the durable synchronous composition of the same native strategy
 * `childRunLoop` drives for detached delegation. It adds stable physical-attempt
 * reservation/recovery and required result persistence around that standard
 * launch primitive; XML presentation remains a delivery adapter.
 *
 * The attempt ledger here is physical: it records reservation and launch edges
 * for one model run. The workflow journal is logical: it records an `agent()`
 * call's replayable value. Journal replay is checked first by the workflow
 * engine; only a journal miss enters this physical attempt layer.
 */

// Third-party imports
import { Cause, Effect, Exit, Fiber, Semaphore } from 'effect';

// Local imports
import {
  getExecutionStore,
  getExecutionRecords,
  type ResultMeta,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import {
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { generateExecutionId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  registerChildExecution,
  startDetachedChildRunLoop,
  type DetachedChildRunInput,
} from './detachedChildRun';
import {
  commitStableSubagentAttempt,
  reserveStableAttempt,
  throwRetryableDurabilityError,
  SubagentCommitError,
  SubagentDurabilityError,
  writeStableSubagentAttempt,
  type StableSubagentAttempt,
} from './stableSubagentAttempt';
import {
  createNativeSubagentStrategy,
  type ChildRunLaunchOptions,
} from './nativeSubagentStrategy';

const log = createLog('inBandSubagentExecution');

interface InBandSubagentExecutionBaseOptions extends ChildRunLaunchOptions {
  readonly configPayload: AgentConfigPayload;
  readonly onCost?: (totalCostUsd: number | undefined) => void | Promise<void>;
  /**
   * Live progress sink for the in-band child. An in-band parent is mid-cycle,
   * so follow-up delivery cannot reach it; each caller degrades deliberately:
   * the headless delegation arm projects progress onto the parent run's trace,
   * and the workflow-script arm omits this because the engine already carries
   * grandchild progress on its own channel (`WorkflowScriptEvent`). Absent
   * therefore means deliberately silent, not accidentally dropped.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

interface StableInBandSubagentExecutionOptions {
  readonly session: SessionHandle;
  /** Cryptographic identity of the prompt/options call, stable across restart. */
  readonly executionId: ExecutionId;
  readonly parentExecutionId: ExecutionId;
  readonly signal?: AbortSignal;
  /** Resolve mutable launch prerequisites only when no result can be recovered. */
  readonly prepare: () => Effect.Effect<
    Omit<InBandSubagentExecutionBaseOptions, 'signal'>,
    Error
  >;
  /**
   * Fires once, just before a live attempt runs, with the execution id that
   * attempt actually uses; the logical id on attempt 0, an attempt-specific
   * id after a durable retry advanced the sequence. This is the id the child
   * stream registers under and the roster exposes, so a host targeting the
   * in-flight child (skip/retry) must key on it, not the pre-derived logical
   * id. Recovered attempts never run live, so this does not fire for them.
   */
  readonly onActiveExecutionId?: (executionId: ExecutionId) => void;
}

/**
 * Options for the XML-delivery API. A one-shot run context need not have a
 * persisted parent execution, so parentage is optional here.
 */
interface InBandSubagentDeliveryOptions extends InBandSubagentExecutionBaseOptions {
  readonly parentExecutionId?: ExecutionId;
}

interface InBandSubagentExecutionResult {
  readonly executionId: ExecutionId;
  readonly result: AgentFinalResult;
}

interface InBandSubagentDeliveryResult extends InBandSubagentExecutionResult {
  readonly delivery: string;
}

type PersistenceMode = 'required-result' | 'best-effort-delivery';

type SettledInBandTurn = Parameters<
  NonNullable<DetachedChildRunInput<never>['onTurnSettled']>
>[0];

// Parent execution ownership is process-local. Serialize duplicate dispatches
// within that owner while durable manifests handle later restart recovery.
const stableExecutions = new Map<
  ExecutionId,
  {
    readonly semaphore: Semaphore.Semaphore;
    users: number;
  }
>();

/**
 * Execute one child through the one shared driver and read its typed result
 * back from the durable record. The child runs under the same detached
 * child-run loop every native child uses (single-cycle strategy, persist-only
 * delivery); "in-band" is only this caller awaiting the loop's completion.
 * Once the run reaches its own terminal persistence, later caller
 * cancellation rejects the awaiting stage but never rewrites the record.
 *
 * Failure taxonomy at the read-back boundary:
 * - completion rejected, or no result manifest exists afterwards → the
 *   infrastructure failed before the child's terminal persistence; durable
 *   callers mark the stable attempt retryable (SubagentDurabilityError).
 * - manifest present with a failed outcome → the child itself failed; the
 *   persisted terminal error message is the thrown message.
 * - manifest present with completed/cancelled outcome → returned typed.
 */
const executeInBand = Effect.fn('executeInBand')(
  function* (
    options: InBandSubagentDeliveryOptions,
    mode: PersistenceMode,
    executionId: ExecutionId,
    stableAttempt?: StableSubagentAttempt,
  ): Effect.fn.Return<InBandSubagentDeliveryResult, Error> {
    options.signal?.throwIfAborted();

    const config = AgentConfigSchema.parse(options.configPayload);
    const startedAt = Date.now();
    const workingDirectory = config.workingDirectory ?? undefined;
    const store = runInSession(options.session, () =>
      getExecutionStore(executionId),
    );

    const { childStreamId } = yield* registerChildExecution(options.session, {
      executionId,
      config,
      agentName: options.agentName,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      parentExecutionId: options.parentExecutionId,
    }).pipe(
      Effect.mapError((cause) =>
        mode === 'required-result'
          ? new SubagentDurabilityError(
              `Failed to register subagent ${executionId}.`,
              { cause },
            )
          : ensureError(cause),
      ),
    );
    let stableCompletionCommitted = false;
    const completed = yield* Effect.gen(function* () {
      let settledTurn: SettledInBandTurn | undefined;
      const { completion } = yield* startDetachedChildRunLoop({
        session: options.session,
        executionId,
        parentStreamId: options.parentStreamId,
        childStreamId,
        agentName: options.agentName,
        recordCost: options.onCost,
        // The parent is blocked awaiting this child, so it rides the parent's
        // budget slot (child-run budget design note).
        budgeted: false,
        ...(options.notify !== undefined && { notify: options.notify }),
        onTurnSettled: (settled) => {
          settledTurn = settled;
        },
        afterArtifactsDrained: Effect.gen(function* () {
          const settledResultMeta = settledTurn?.resultMeta;
          if (
            !stableAttempt ||
            settledTurn?.isError === true ||
            settledResultMeta?.producer !== 'subagent' ||
            settledResultMeta.result.outcome !== RUN_OUTCOME.COMPLETED
          ) {
            return;
          }
          yield* commitStableSubagentAttempt(
            store,
            executionId,
            stableAttempt,
            options.session,
          );
          stableCompletionCommitted = true;
        }),
        buildLaunch: () =>
          Effect.gen(function* () {
            // Inside the loop's lease launch guard, like every attempt-scoped
            // setup: a throw here releases the owned-execution lease.
            if (stableAttempt) {
              yield* Effect.tryPromise({
                try: () =>
                  runInSession(options.session, () =>
                    writeStableSubagentAttempt(store, {
                      ...stableAttempt,
                      phase: 'launched',
                    }),
                  ),
                catch: (cause) =>
                  new SubagentDurabilityError(
                    `Failed to mark subagent ${executionId} as launched.`,
                    { cause },
                  ),
              });
            }
            return {
              strategy: createNativeSubagentStrategy({
                ...options,
                config,
                agentCategoryExplicit: true,
                executionId,
                startedAt,
                workingDirectory,
                executionMode: 'single-cycle',
                resultOnly: mode === 'required-result',
                userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
              }),
            };
          }),
      });

      const completionExit = yield* Effect.exit(Fiber.join(completion));
      const loopFailure = Exit.isFailure(completionExit)
        ? Cause.squash(completionExit.cause)
        : undefined;

      // The loop hands this caller the settled turn's facts only once its
      // report and result manifest are on disk; no turn settling means the run
      // was interrupted, or a delivery write or the infrastructure failed
      // before terminal persistence; durable callers mark the attempt
      // retryable.
      const resultMeta = settledTurn?.resultMeta;
      if (!settledTurn || !resultMeta || resultMeta.producer !== 'subagent') {
        const failure = new SubagentDurabilityError(
          `Subagent ${executionId} ended without a settled typed result (interrupted before terminal persistence, or the run loop failed).`,
          loopFailure !== undefined ? { cause: loopFailure } : undefined,
        );
        if (mode === 'required-result') {
          return yield* throwRetryableDurabilityError(
            executionId,
            stableAttempt,
            failure,
            options.session,
          );
        }
        throw failure;
      }

      const result = resultMeta.result;
      const childFailed =
        settledTurn.isError || result.outcome === RUN_OUTCOME.FAILED;
      // The raw application error when the turn threw; otherwise the typed
      // result's own structured error (the result-only contract). Read the
      // settled turn's fields into consts: `settledTurn` stays assignable inside
      // the onTurnSettled callback, so a closure cannot keep the narrowing.
      const turnError = settledTurn.error;
      const turnMessage = settledTurn.message;
      const childError = () =>
        turnError ??
        new Error(
          result.error?.message ??
            `Subagent ${executionId} ended with failed outcome.`,
        );

      if (loopFailure instanceof SubagentCommitError) throw loopFailure;
      if (loopFailure !== undefined && stableCompletionCommitted) {
        throw new SubagentDurabilityError(
          `Subagent ${executionId} committed durable completion but failed to release its execution lease.`,
          { cause: loopFailure },
        );
      }

      if (mode === 'required-result') {
        // The ledger recovers restarts by inspecting the persisted manifest, so
        // the in-memory copy is not enough here: verify the write landed. A
        // FAILED child's attempt is marked retryable (re-running a failed child
        // is safe); a COMPLETED child whose manifest did not persist keeps its
        // 'launched' marker, so a later run refuses to repeat side-effectful
        // work rather than executing it twice.
        let persisted: ResultMeta | null;
        // A read failure is NOT the same fact as a missing manifest: keep it so
        // the thrown error names the I/O cause instead of blaming persistence.
        let readFailure: unknown;
        const persistedExit = yield* Effect.exit(
          getExecutionRecords(options.session, executionId).readResultMeta(),
        );
        if (Exit.isSuccess(persistedExit)) {
          persisted = persistedExit.value;
        } else {
          readFailure = Cause.squash(persistedExit.cause);
          log.warn('Failed to read the persisted result manifest', {
            data: { executionId, error: readFailure },
          });
          persisted = null;
        }
        if (!persisted) {
          if (childFailed) {
            const error = childError();
            return yield* throwRetryableDurabilityError(
              executionId,
              stableAttempt,
              new SubagentDurabilityError(
                `Subagent ${executionId} failed (${toErrorMessage(error)}), and its failure result could not be persisted.`,
                {
                  cause: new AggregateError(
                    readFailure === undefined ? [error] : [error, readFailure],
                    `Subagent ${executionId} execution and persistence both failed.`,
                  ),
                },
              ),
              options.session,
            );
          }
          if (readFailure !== undefined) {
            throw new SubagentDurabilityError(
              `Failed to verify the persisted result for subagent ${executionId}.`,
              { cause: readFailure },
            );
          }
          throw new SubagentDurabilityError(
            `Failed to persist result for subagent ${executionId}.`,
          );
        }
      }

      if (
        mode === 'required-result' &&
        loopFailure !== undefined &&
        !childFailed
      ) {
        return yield* throwRetryableDurabilityError(
          executionId,
          stableAttempt,
          new SubagentDurabilityError(
            `Subagent ${executionId} failed to persist its final artifacts.`,
            { cause: loopFailure },
          ),
          options.session,
        );
      }

      if (childFailed) {
        throw childError();
      }

      return { executionId, result, delivery: turnMessage };
    });

    // Post-run cancellation deliberately observes a terminal record: stable
    // success was committed inside the post-drain/pre-release lease boundary,
    // then the awaiting caller rejects without rewriting the child.
    options.signal?.throwIfAborted();
    return completed;
  },
  Effect.uninterruptible,
  Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
);

/** Recover a logical child first; resolve launch-only state only when needed. */
export const executeStableSubagentInBand = Effect.fn(
  'executeStableSubagentInBand',
)(
  function* (
    options: StableInBandSubagentExecutionOptions,
  ): Effect.fn.Return<InBandSubagentExecutionResult, Error> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const reservation = yield* Effect.acquireRelease(
          Effect.sync(() => {
            let reservation = stableExecutions.get(options.executionId);
            if (!reservation) {
              reservation = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
              stableExecutions.set(options.executionId, reservation);
            }
            reservation.users += 1;
            return reservation;
          }),
          (reservation) =>
            Effect.sync(() => {
              reservation.users -= 1;
              if (reservation.users === 0)
                stableExecutions.delete(options.executionId);
            }),
        );
        return yield* reservation.semaphore.withPermit(
          Effect.gen(function* () {
            const reserved = yield* reserveStableAttempt(
              options,
              options.session,
            );
            if (reserved.kind === 'recovered') return reserved.result;
            const { executionId, attempt } = reserved;
            // Publish the physical attempt id before resolving mutable launch state.
            options.onActiveExecutionId?.(executionId);
            const prepared = yield* options.prepare();
            const completed = yield* executeInBand(
              {
                ...prepared,
                parentExecutionId: options.parentExecutionId,
                signal: options.signal,
              },
              'required-result',
              executionId,
              attempt,
            );
            return {
              executionId: completed.executionId,
              result: completed.result,
            };
          }),
        );
      }),
    );
  },
  Effect.uninterruptible,
  Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
);

/** Run one child and return its XML delivery alongside the typed result. */
export const executeSubagentForDeliveryInBand = Effect.fn(
  'executeSubagentForDeliveryInBand',
)(function* (
  options: InBandSubagentDeliveryOptions,
): Effect.fn.Return<InBandSubagentDeliveryResult, Error> {
  return yield* executeInBand(
    options,
    'best-effort-delivery',
    generateExecutionId(),
  );
});
