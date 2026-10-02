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
 * identity (the `agent` tool derives the attempt's run id and probes it);
 * this module only ever starts the run it is handed.
 */

// Third-party imports
import { Cause, Data, Effect, Exit, Fiber } from 'effect';

// Local imports
import { getRunRecords } from '@agent/storage';
import { registerRun } from '@agent/storage/runLifecycle';
import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import type { ResumeTurnIdentity } from '@agent/runtime/executeAgent';
import { childToolRefusal } from '@agent/runtime/agentToolResolution';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import {
  RunArtifactDrainError,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { Runs, type AgentRunServices } from '@agent/runtime/runRegistry';
import {
  createNativeSubagentStrategy,
  type ChildRunLaunchOptions,
} from '@agent/runtime/nativeSubagentStrategy';
import { withLogChannel } from '@logger/effectLog';
import {
  RUN_OUTCOME,
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  type OfferedTool,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  startDetachedChildRunLoop,
  type DetachedChildRunInput,
} from './detachedChildRun';

const CHANNEL = 'inBandSubagentRun';

/**
 * A required-result child left no typed result to read back: the
 * infrastructure failed before or around the child's terminal persistence.
 * Kept distinct from the child's own failure, which is an ordinary failed
 * call, because a durability fault must abort the caller's run instead of
 * returning a null value to it.
 */
export class SubagentDurabilityError extends Data.TaggedError(
  'SubagentDurabilityError',
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface InBandSubagentRunBaseOptions extends ChildRunLaunchOptions {
  readonly configPayload: AgentConfigPayload;
  /** The parent's tool card whose call launches the child. */
  readonly parentCard?: string;
  /** What the parent's step offered, which the child can only narrow. */
  readonly parentOffered: readonly OfferedTool[];
  /**
   * Live progress sink for the in-band child. An in-band parent is mid-cycle,
   * so follow-up delivery cannot reach it; the caller projects progress onto
   * the parent run's trace instead. Absent means deliberately silent, not
   * accidentally dropped.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

/** One child launched under a run id the caller has already derived. */
export interface InBandSubagentLaunchOptions {
  readonly session: SessionHandle;
  /** The run this attempt executes under; the caller owns its derivation. */
  readonly runId: RunId;
  readonly parentRunId: RunId;
  /** Resolve mutable launch prerequisites only when a launch actually happens. */
  readonly prepare: () => Effect.Effect<
    InBandSubagentRunBaseOptions,
    Error,
    AgentRunServices
  >;
}

interface InBandSubagentRunResult {
  readonly runId: RunId;
  readonly result: RunEnd;
}

/** A child launched fresh from its definition, or a persisted one resumed
 *  where it stopped under the run id it already has. */
type InBandLaunch =
  | { readonly kind: 'fresh'; readonly definition: PreparedAgentDefinition }
  | { readonly kind: 'resume'; readonly identity: ResumeTurnIdentity };

type SettledInBandTurn = Parameters<
  NonNullable<DetachedChildRunInput<never>['onTurnSettled']>
>[0];

/** Resolve the definition once before either in-band launch path registers it. */
const prepareInBandDefinition = Effect.fn('prepareInBandDefinition')(function* (
  options: InBandSubagentRunBaseOptions,
) {
  return yield* prepareAgentDefinition({
    config: AgentConfigSchema.parse(options.configPayload),
    session: options.session,
    enforceCategory: true,
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
 * - no persisted `run.result` manifest → the row a later attempt would
 *   recover from never landed, so the call is refused
 *   here rather than left unrecoverable (SubagentDurabilityError).
 * - terminal row says failed → the child itself failed; the persisted
 *   terminal error message is the thrown message.
 * - terminal row says completed/cancelled → returned typed.
 *
 * A loop failure after the turn settled does not rewrite the outcome when the
 * child's rows were already committed: the committed rows are the fact, and a
 * claim release or ending that threw afterwards leaves them whole. A
 * failed artifact drain is the exception: it rolled back facts the run had
 * queued, so the caller must not answer the call from it.
 * It is read from either place it can be seen — the loop's own
 * `RunArtifactDrainError`, and the `artifact-drain` marker the run's lifecycle
 * left on the terminal row.
 */
const executeInBand = Effect.fn('executeInBand')(
  function* (
    options: InBandSubagentRunBaseOptions,
    launch: InBandLaunch,
    runId: RunId,
  ): Effect.fn.Return<InBandSubagentRunResult, Error, AgentRunServices> {
    const config =
      launch.kind === 'fresh'
        ? launch.definition.config
        : launch.identity.agentConfig;
    const startedAt = Date.now();
    const workingDirectory = config.workingDirectory ?? undefined;
    if (launch.kind === 'fresh') {
      // A child that needs a plugin its parent's step lacks is an ordinary
      // failed call, refused before any row records it.
      const refusal = childToolRefusal(
        options.parentOffered,
        launch.definition.setting.tools,
        config.agent,
      );
      if (refusal !== undefined) return yield* Effect.fail(new Error(refusal));

      yield* registerRun(options.session, runId, config, {
        identity: { kind: 'agent', agent: config.agent },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
        parentRunId: options.parentRunId,
        ...(options.parentCard !== undefined && {
          parentCard: options.parentCard,
        }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SubagentDurabilityError({
              message: `Failed to register subagent ${runId}.`,
              cause,
            }),
        ),
      );
    }
    let settledTurn: SettledInBandTurn | undefined;
    const { completion } = yield* startDetachedChildRunLoop({
      session: options.session,
      runId,
      parentRunId: options.parentRunId,
      agentName: config.agent,
      // The parent is blocked awaiting this child, so it rides the parent's
      // budget slot (child-run budget design note).
      budgeted: false,
      ...(options.notify !== undefined && { notify: options.notify }),
      onTurnSettled: (settled) => {
        settledTurn = settled;
      },
      // Built inside the loop's launch guard, like every attempt-scoped
      // setup: a throw here ends the run and releases its claim.
      buildLaunch: () =>
        Effect.succeed({
          strategy: createNativeSubagentStrategy({
            ...options,
            ...(launch.kind === 'fresh'
              ? { definition: launch.definition }
              : {
                  resume: {
                    identity: launch.identity,
                    // Single cycle: the resumed turn ends the run, as the
                    // launch's own would have.
                    options: {
                      session: options.session,
                      stopAfterCycle: true,
                    },
                  },
                }),
            runId,
            startedAt,
            workingDirectory,
            runMode: 'single-cycle',
            resultOnly: true,
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
      return yield* Effect.fail(
        new SubagentDurabilityError({
          message: `Subagent ${runId} ended without a settled typed result (interrupted before terminal persistence, or the run loop failed).`,
          cause: loopFailure,
        }),
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
      yield* Effect.logWarning('Failed to read the terminal run fact').pipe(
        Effect.annotateLogs({ data: { runId, error: endFailure } }),
        withLogChannel(CHANNEL),
      );
    const childFailed =
      settledTurn.isError || runEnd?.outcome === RUN_OUTCOME.FAILED;
    // The raw application error when the turn threw; otherwise the terminal
    // row's own structured error (the result-only contract). Read the
    // settled turn's fields into consts: `settledTurn` stays assignable inside
    // the onTurnSettled callback, so a closure cannot keep the narrowing.
    const turnError = settledTurn.error;
    const childError = () =>
      turnError ??
      new Error(
        runEnd?.error?.message ??
          `Subagent ${runId} ended with failed outcome.`,
      );

    // The caller answers a call whose recovery reads the child's own
    // `run.result` row, so the in-memory manifest is not enough:
    // a completed run whose manifest never landed is precisely what recovery
    // refuses to repeat, so the write is verified here, where the failure can
    // still be named. A read failure stays distinct from an absent row so the
    // thrown error blames the I/O cause rather than persistence.
    {
      const persistedExit = yield* Effect.exit(
        getRunRecords(options.session, runId).readResultMeta(),
      );
      const readFailure = Exit.isFailure(persistedExit)
        ? Cause.squash(persistedExit.cause)
        : undefined;
      if (readFailure !== undefined)
        yield* Effect.logWarning(
          'Failed to read the persisted result manifest',
        ).pipe(
          Effect.annotateLogs({ data: { runId, error: readFailure } }),
          withLogChannel(CHANNEL),
        );
      const persisted = Exit.isSuccess(persistedExit)
        ? persistedExit.value
        : null;
      if (persisted === null) {
        if (childFailed) {
          const error = childError();
          return yield* Effect.fail(
            new SubagentDurabilityError({
              message: `Subagent ${runId} failed (${toErrorMessage(error)}), and its failure result could not be persisted.`,
              cause: new AggregateError(
                readFailure === undefined ? [error] : [error, readFailure],
                `Subagent ${runId} run and persistence both failed.`,
              ),
            }),
          );
        }
        return yield* Effect.fail(
          new SubagentDurabilityError({
            message:
              readFailure === undefined
                ? `Failed to persist result for subagent ${runId}.`
                : `Failed to verify the persisted result for subagent ${runId}.`,
            cause: readFailure,
          }),
        );
      }
    }

    // A drain rolled back facts this run had queued, so the call is not
    // durably answered: the caller answers from those rows.
    // It outranks how the child itself ended, which the terminal row is
    // reporting as failed for this very reason (the row is the post-drain
    // fact). Two drains can lose it, and only one of them reaches here as an
    // error: the pre-terminal drain the run's own lifecycle ran is only
    // legible on the row it marked (a publication that fails once is settled
    // and gone by the time the ending's drain runs), while the ending's
    // drain fails this loop, alone or wrapped with its other cleanup
    // failures.
    if (
      runEnd?.error?.kind === 'artifact-drain' ||
      loopFailure instanceof RunArtifactDrainError ||
      (loopFailure instanceof AggregateError &&
        loopFailure.errors.some(
          (error: unknown) => error instanceof RunArtifactDrainError,
        ))
    ) {
      return yield* Effect.fail(
        new SubagentDurabilityError({
          message: `Subagent ${runId} failed to commit its final artifacts.`,
          cause: loopFailure,
        }),
      );
    }

    if (childFailed) return yield* Effect.fail(ensureError(childError()));

    if (!runEnd) {
      // The child did not fail, so the missing terminal row is an
      // infrastructure gap: the run's lifecycle never committed it, or the
      // read of it failed.
      return yield* Effect.fail(
        new SubagentDurabilityError({
          message: `Subagent ${runId} ended without a terminal record.`,
          cause: endFailure,
        }),
      );
    }

    // A caller stop landing here interrupts the join, not the child: the
    // child's rows were committed under its own claim and the
    // detached loop owns its terminal record.
    return { runId, result: { ...runEnd, output: resultMeta.output } };
  },
  // Interruptible: the registration is one durable commit and the detached
  // loop owns the child from its first tick, so an interruption lands in the
  // join or the read-back and leaves the same rows a crash would.
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.fail(ensureError(Cause.squash(cause))),
  ),
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
 * settle its own terminal record. A launch that has no live run yet is
 * interrupted where it is; one whose loop started inside the launch's
 * uninterruptible hand-off is stopped once that hand-off returns.
 */
export const executeSubagentInBand = (
  options: InBandSubagentLaunchOptions,
): Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices> =>
  awaitInBand(options.runId, launchSubagentInBand(options));

/**
 * Resume a persisted child under the run id it already has and await it as
 * {@link executeSubagentInBand} awaits a launch: the child continues where
 * its last owner stopped, in one cycle, and its typed result is read back
 * from the record. Its stored configuration is what it runs under.
 */
export const resumeSubagentInBand = (
  options: Omit<
    InBandSubagentRunBaseOptions,
    'configPayload' | 'parentOffered'
  > & {
    readonly runId: RunId;
  },
): Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices> =>
  awaitInBand(
    options.runId,
    Effect.gen(function* () {
      const agentConfig = yield* getRunRecords(
        options.session,
        options.runId,
      ).readConfig();
      if (agentConfig === null)
        return yield* new SubagentDurabilityError({
          message: `Subagent ${options.runId} has no stored configuration to resume.`,
        });
      return yield* executeInBand(
        { ...options, configPayload: agentConfig, parentOffered: [] },
        { kind: 'resume', identity: { runId: options.runId, agentConfig } },
        options.runId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.fail(ensureError(Cause.squash(cause))),
      ),
    ),
  );

/** Await one in-band child's program; interrupting the caller stops the
 *  child by its run id and waits for it to settle its own record. */
const awaitInBand = (
  runId: RunId,
  program: Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices>,
): Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices> =>
  Effect.gen(function* () {
    const runs = yield* Runs;
    const child = yield* Effect.forkChild(program, {
      startImmediately: true,
    });
    return yield* Fiber.join(child).pipe(
      Effect.onInterrupt(() =>
        Effect.suspend(() =>
          runs.interruptActive(runId)
            ? Fiber.await(child)
            : Fiber.interrupt(child).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    runs.interruptActive(runId);
                  }),
                ),
              ),
        ),
      ),
    );
  });

const launchSubagentInBand = Effect.fn('executeSubagentInBand')(
  function* (
    options: InBandSubagentLaunchOptions,
  ): Effect.fn.Return<InBandSubagentRunResult, Error, AgentRunServices> {
    const prepared = yield* options.prepare();
    const definition = yield* prepareInBandDefinition(prepared);
    // Validate the current definition, not metadata left by an earlier
    // catalog load.
    if (
      definition.config.agentCategory === AgentCategory.Workflow &&
      definition.config.inputFiles.length === 0 &&
      definition.setting.defaultOutputFiles.length === 0
    ) {
      return yield* Effect.fail(
        new Error(
          `Workflow agent '${definition.config.agent}' edits files: pass options.inputFiles ` +
            `with files that still exist (its result carries output files and ` +
            `diffs, not response text).`,
        ),
      );
    }
    return yield* executeInBand(
      prepared,
      { kind: 'fresh', definition },
      options.runId,
    );
  },
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.fail(ensureError(Cause.squash(cause))),
  ),
);
