/**
 * In-band native subagent run for callers that consume a typed result.
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
import { getRunStore, getRunRecords } from '@agent/storage';
import { WorkflowRunAbortError } from '@agent/workflowScript/runWorkflowScript';
import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunServices } from '@agent/runtime/toolInjection';
import { createLog } from '@logger/logUtils';
import {
  RUN_OUTCOME,
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  type ResultMeta,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { generateRunId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  registerChildRun,
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

const log = createLog('inBandSubagentRun');

interface InBandSubagentRunBaseOptions extends ChildRunLaunchOptions {
  readonly configPayload: AgentConfigPayload;
  readonly onCost?: (costUsd: number | undefined) => void | Promise<void>;
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

interface StableInBandSubagentRunOptions {
  readonly session: SessionHandle;
  /** Cryptographic identity of the prompt/options call, stable across restart. */
  readonly runId: RunId;
  readonly parentRunId: RunId;
  readonly signal?: AbortSignal;
  /** Resolve mutable launch prerequisites only when no result can be recovered. */
  readonly prepare: () => Effect.Effect<
    Omit<InBandSubagentRunBaseOptions, 'signal'>,
    Error,
    AgentRunServices
  >;
  /**
   * Fires once, just before a live attempt runs, with the run id that
   * attempt actually uses; the logical id on attempt 0, an attempt-specific
   * id after a durable retry advanced the sequence. This is the id the child
   * stream registers under and the roster exposes, so a host targeting the
   * in-flight child (skip/retry) must key on it, not the pre-derived logical
   * id. Recovered attempts never run live, so this does not fire for them.
   */
  readonly onActiveRunId?: (runId: RunId) => void;
}

/** Options for the XML-delivery API. */
type InBandSubagentDeliveryOptions = InBandSubagentRunBaseOptions;

interface InBandSubagentRunResult {
  readonly runId: RunId;
  readonly result: RunEnd;
}

interface InBandSubagentDeliveryResult extends InBandSubagentRunResult {
  readonly delivery: string;
}

type PersistenceMode = 'required-result' | 'best-effort-delivery';

type SettledInBandTurn = Parameters<
  NonNullable<DetachedChildRunInput<never>['onTurnSettled']>
>[0];

// Parent run ownership is process-local. Serialize duplicate dispatches
// within that owner while durable manifests handle later restart recovery.
const stableRuns = new Map<
  RunId,
  {
    readonly semaphore: Semaphore.Semaphore;
    users: number;
  }
>();

/** Resolve the definition once before either in-band launch path registers it. */
const prepareInBandDefinition = Effect.fn('prepareInBandDefinition')(function* (
  options: InBandSubagentDeliveryOptions,
) {
  options.signal?.throwIfAborted();
  return yield* prepareAgentDefinition({
    config: AgentConfigSchema.parse(options.configPayload),
    session: options.session,
    enforceCategory: true,
    signal: options.signal,
    suppressErrorNotification: true,
  });
});

/**
 * Execute one child through the one shared driver and read its typed result
 * back from the durable record. The child runs under the same detached
 * child-run loop every native child uses (single-cycle strategy, persist-only
 * delivery); "in-band" is only this caller awaiting the loop's completion.
 * Once the run reaches its own terminal persistence, later caller
 * cancellation rejects the awaiting stage but never rewrites the record.
 *
 * Failure taxonomy at the read-back boundary:
 * - completion rejected, or no `run.end` row / result manifest exists
 *   afterwards → the infrastructure failed before the child's terminal
 *   persistence; durable callers mark the stable attempt retryable
 *   (SubagentDurabilityError).
 * - terminal row says failed → the child itself failed; the persisted
 *   terminal error message is the thrown message.
 * - terminal row says completed/cancelled → returned typed.
 */
const executeInBand = Effect.fn('executeInBand')(
  function* (
    options: InBandSubagentDeliveryOptions,
    definition: PreparedAgentDefinition,
    mode: PersistenceMode,
    runId: RunId,
    stableAttempt?: StableSubagentAttempt,
  ): Effect.fn.Return<InBandSubagentDeliveryResult, Error, AgentRunServices> {
    const { config } = definition;
    const startedAt = Date.now();
    const workingDirectory = config.workingDirectory ?? undefined;
    const store = runInSession(options.session, () => getRunStore(runId));

    yield* registerChildRun(options.session, {
      runId,
      config,
      agentName: options.agentName,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      parentRunId: options.parentRunId,
    }).pipe(
      Effect.mapError((cause) =>
        mode === 'required-result'
          ? new SubagentDurabilityError(
              `Failed to register subagent ${runId}.`,
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
        runId,
        parentRunId: options.parentRunId,
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
          if (
            !stableAttempt ||
            settledTurn?.isError === true ||
            settledTurn?.resultMeta?.producer !== 'subagent'
          ) {
            return;
          }
          // How the child ended is the `run.end` row's fact, already written
          // by the run's own lifecycle before this drain hook runs.
          const runEnd = yield* getRunRecords(
            options.session,
            runId,
          ).readRunEnd();
          if (runEnd?.outcome !== RUN_OUTCOME.COMPLETED) return;
          yield* commitStableSubagentAttempt(
            store,
            runId,
            stableAttempt,
            options.session,
          );
          stableCompletionCommitted = true;
        }),
        buildLaunch: () =>
          Effect.gen(function* () {
            // Inside the loop's lease launch guard, like every attempt-scoped
            // setup: a throw here releases the owned-run lease.
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
                    `Failed to mark subagent ${runId} as launched.`,
                    { cause },
                  ),
              });
            }
            return {
              strategy: createNativeSubagentStrategy({
                ...options,
                definition,
                runId,
                startedAt,
                workingDirectory,
                runMode: 'single-cycle',
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
          `Subagent ${runId} ended without a settled typed result (interrupted before terminal persistence, or the run loop failed).`,
          loopFailure !== undefined ? { cause: loopFailure } : undefined,
        );
        if (mode === 'required-result') {
          return yield* throwRetryableDurabilityError(
            runId,
            stableAttempt,
            failure,
            options.session,
          );
        }
        throw failure;
      }

      // How the child ended is the `run.end` row's fact, written by the run's
      // own lifecycle; the manifest carries only the output as this turn's
      // delivery enriched it. A read failure is kept apart from an absent row
      // so the thrown error can name the I/O cause.
      const endExit = yield* Effect.exit(
        getRunRecords(options.session, runId).readRunEnd(),
      );
      const runEnd = Exit.isSuccess(endExit) ? endExit.value : null;
      const endFailure = Exit.isFailure(endExit)
        ? Cause.squash(endExit.cause)
        : undefined;
      if (endFailure !== undefined)
        log.warn('Failed to read the terminal run fact', {
          data: { runId, error: endFailure },
        });
      const childFailed =
        settledTurn.isError || runEnd?.outcome === RUN_OUTCOME.FAILED;
      // The raw application error when the turn threw; otherwise the terminal
      // row's own structured error (the result-only contract). Read the
      // settled turn's fields into consts: `settledTurn` stays assignable inside
      // the onTurnSettled callback, so a closure cannot keep the narrowing.
      const turnError = settledTurn.error;
      const turnMessage = settledTurn.message;
      const childError = () =>
        turnError ??
        new Error(
          runEnd?.error?.message ??
            `Subagent ${runId} ended with failed outcome.`,
        );

      if (loopFailure instanceof SubagentCommitError) throw loopFailure;
      if (loopFailure !== undefined && stableCompletionCommitted) {
        throw new SubagentDurabilityError(
          `Subagent ${runId} committed durable completion but failed to release its run lease.`,
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
          getRunRecords(options.session, runId).readResultMeta(),
        );
        if (Exit.isSuccess(persistedExit)) {
          persisted = persistedExit.value;
        } else {
          readFailure = Cause.squash(persistedExit.cause);
          log.warn('Failed to read the persisted result manifest', {
            data: { runId, error: readFailure },
          });
          persisted = null;
        }
        if (!persisted) {
          if (childFailed) {
            const error = childError();
            return yield* throwRetryableDurabilityError(
              runId,
              stableAttempt,
              new SubagentDurabilityError(
                `Subagent ${runId} failed (${toErrorMessage(error)}), and its failure result could not be persisted.`,
                {
                  cause: new AggregateError(
                    readFailure === undefined ? [error] : [error, readFailure],
                    `Subagent ${runId} run and persistence both failed.`,
                  ),
                },
              ),
              options.session,
            );
          }
          if (readFailure !== undefined) {
            throw new SubagentDurabilityError(
              `Failed to verify the persisted result for subagent ${runId}.`,
              { cause: readFailure },
            );
          }
          throw new SubagentDurabilityError(
            `Failed to persist result for subagent ${runId}.`,
          );
        }
      }

      if (
        mode === 'required-result' &&
        loopFailure !== undefined &&
        !childFailed
      ) {
        return yield* throwRetryableDurabilityError(
          runId,
          stableAttempt,
          new SubagentDurabilityError(
            `Subagent ${runId} failed to persist its final artifacts.`,
            { cause: loopFailure },
          ),
          options.session,
        );
      }

      if (childFailed) {
        throw childError();
      }

      if (!runEnd) {
        // The child did not fail, so the missing terminal row is an
        // infrastructure gap: the run's lifecycle never committed it, or the
        // read of it failed.
        const failure = new SubagentDurabilityError(
          `Subagent ${runId} ended without a terminal record.`,
          endFailure !== undefined ? { cause: endFailure } : undefined,
        );
        if (mode === 'required-result') {
          return yield* throwRetryableDurabilityError(
            runId,
            stableAttempt,
            failure,
            options.session,
          );
        }
        throw failure;
      }

      return {
        runId,
        result: { ...runEnd, output: resultMeta.output },
        delivery: turnMessage,
      };
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
    options: StableInBandSubagentRunOptions,
  ): Effect.fn.Return<InBandSubagentRunResult, Error, AgentRunServices> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const reservation = yield* Effect.acquireRelease(
          Effect.sync(() => {
            let reservation = stableRuns.get(options.runId);
            if (!reservation) {
              reservation = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
              stableRuns.set(options.runId, reservation);
            }
            reservation.users += 1;
            return reservation;
          }),
          (reservation) =>
            Effect.sync(() => {
              reservation.users -= 1;
              if (reservation.users === 0) stableRuns.delete(options.runId);
            }),
        );
        return yield* reservation.semaphore.withPermit(
          Effect.gen(function* () {
            const reserved = yield* reserveStableAttempt(
              options,
              options.session,
            );
            if (reserved.kind === 'recovered') return reserved.result;
            const { runId, attempt } = reserved;
            // Publish the physical attempt id before resolving mutable launch state.
            options.onActiveRunId?.(runId);
            const prepared = yield* options.prepare();
            const launch = { ...prepared, signal: options.signal };
            const definition = yield* prepareInBandDefinition(launch);
            // Validate the current definition, not metadata left by an earlier
            // catalog load. Recovery returned above without loading it again.
            if (
              definition.config.agentCategory === AgentCategory.Workflow &&
              definition.config.inputFiles.length === 0 &&
              definition.setting.defaultOutputFiles.length === 0
            ) {
              return yield* Effect.fail(
                new WorkflowRunAbortError(
                  `Workflow agent '${launch.agentName}' edits files: pass options.inputFiles ` +
                    `with files that still exist (its result carries output files and ` +
                    `diffs, not response text).`,
                ),
              );
            }
            const completed = yield* executeInBand(
              launch,
              definition,
              'required-result',
              runId,
              attempt,
            );
            return {
              runId: completed.runId,
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
): Effect.fn.Return<InBandSubagentDeliveryResult, Error, AgentRunServices> {
  const definition = yield* prepareInBandDefinition(options);
  return yield* executeInBand(
    options,
    definition,
    'best-effort-delivery',
    generateRunId(),
  );
});
