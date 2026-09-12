/**
 * Await one native subagent child in band, for callers that consume a typed
 * result.
 *
 * The child runs under the same `childRunLoop` every detached delegation
 * drives, with the same single-cycle native strategy and persist-only
 * delivery; "in-band" is only this caller blocking on the loop's completion,
 * and XML presentation remains a delivery adapter. The child's own run
 * aggregate is the durable record of what happened, so whether an earlier
 * child already answered a logical call belongs to whoever owns that call
 * identity (the workflow-script runner derives the attempt's run id and probes
 * it); this module only ever starts the run it is handed.
 */

// Third-party imports
import { Cause, Effect, Exit, Fiber } from 'effect';

// Local imports
import { getRunRecords } from '@agent/storage';
import { WorkflowRunAbortError } from '@agent/workflowScript/runWorkflowScript';
import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunServices } from '@agent/runtime/toolInjection';
import { createLog } from '@logger/logUtils';
import {
  RUN_OUTCOME,
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { generateRunId } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import {
  registerChildRun,
  startDetachedChildRunLoop,
  type DetachedChildRunInput,
} from './detachedChildRun';
import {
  createNativeSubagentStrategy,
  type ChildRunLaunchOptions,
} from './nativeSubagentStrategy';

const log = createLog('inBandSubagentRun');

/**
 * A required-result child left no typed result to read back: the
 * infrastructure failed before or around the child's terminal persistence.
 * Kept distinct from the child's own failure, which is an ordinary failed
 * call, because a durability fault must abort the caller's run instead of
 * returning a null value to it.
 */
export class SubagentDurabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubagentDurabilityError';
  }
}

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

/** One child launched under a run id the caller has already derived. */
export interface InBandSubagentLaunchOptions {
  readonly session: SessionHandle;
  /** The run this attempt executes under; the caller owns its derivation. */
  readonly runId: RunId;
  readonly parentRunId: RunId;
  readonly signal?: AbortSignal;
  /** Resolve mutable launch prerequisites only when a launch actually happens. */
  readonly prepare: () => Effect.Effect<
    Omit<InBandSubagentRunBaseOptions, 'signal'>,
    Error,
    AgentRunServices
  >;
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
 * - completion rejected, or no settled typed result / no `run.end` row
 *   afterwards → the infrastructure failed before the child's terminal
 *   persistence, so there is no typed result to return
 *   (SubagentDurabilityError).
 * - terminal row says failed → the child itself failed; the persisted
 *   terminal error message is the thrown message.
 * - terminal row says completed/cancelled → returned typed.
 *
 * A loop failure after the turn settled (a lease release or artifact cleanup
 * that threw once the child's rows were already committed) does not rewrite
 * the outcome: the committed rows are the fact.
 */
const executeInBand = Effect.fn('executeInBand')(
  function* (
    options: InBandSubagentDeliveryOptions,
    definition: PreparedAgentDefinition,
    mode: PersistenceMode,
    runId: RunId,
  ): Effect.fn.Return<InBandSubagentDeliveryResult, Error, AgentRunServices> {
    const { config } = definition;
    const startedAt = Date.now();
    const workingDirectory = config.workingDirectory ?? undefined;

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
        // Built inside the loop's lease launch guard, like every
        // attempt-scoped setup: a throw here releases the owned-run lease.
        buildLaunch: () =>
          Effect.succeed({
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
          }),
      });

      const completionExit = yield* Effect.exit(Fiber.join(completion));
      const loopFailure = Exit.isFailure(completionExit)
        ? Cause.squash(completionExit.cause)
        : undefined;

      // The loop hands this caller the settled turn's facts only once its
      // report and result manifest are on disk; no turn settling means the run
      // was interrupted, or a delivery write or the infrastructure failed
      // before terminal persistence.
      const resultMeta = settledTurn?.resultMeta;
      if (!settledTurn || !resultMeta || resultMeta.producer !== 'subagent') {
        throw new SubagentDurabilityError(
          `Subagent ${runId} ended without a settled typed result (interrupted before terminal persistence, or the run loop failed).`,
          loopFailure !== undefined ? { cause: loopFailure } : undefined,
        );
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

      if (childFailed) {
        throw (
          turnError ??
          new Error(
            runEnd?.error?.message ??
              `Subagent ${runId} ended with failed outcome.`,
          )
        );
      }

      if (!runEnd) {
        // The child did not fail, so the missing terminal row is an
        // infrastructure gap: the run's lifecycle never committed it, or the
        // read of it failed.
        throw new SubagentDurabilityError(
          `Subagent ${runId} ended without a terminal record.`,
          endFailure !== undefined ? { cause: endFailure } : undefined,
        );
      }

      return {
        runId,
        result: { ...runEnd, output: resultMeta.output },
        delivery: turnMessage,
      };
    });

    // Post-run cancellation deliberately observes a terminal record: the
    // child's rows were committed inside its own lease boundary, then the
    // awaiting caller rejects without rewriting them.
    options.signal?.throwIfAborted();
    return completed;
  },
  Effect.uninterruptible,
  Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
);

/**
 * Launch one child under the run id its caller derived and read the typed
 * result back from the durable record. Recovering an earlier attempt belongs
 * to the caller that owns the call identity; this only ever starts a new run.
 */
export const executeSubagentInBand = Effect.fn('executeSubagentInBand')(
  function* (
    options: InBandSubagentLaunchOptions,
  ): Effect.fn.Return<InBandSubagentRunResult, Error, AgentRunServices> {
    const prepared = yield* options.prepare();
    const launch = { ...prepared, signal: options.signal };
    const definition = yield* prepareInBandDefinition(launch);
    // Validate the current definition, not metadata left by an earlier
    // catalog load.
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
      options.runId,
    );
    return { runId: completed.runId, result: completed.result };
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
