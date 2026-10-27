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
import { Cause, Clock, Effect, Exit, Fiber, Option, Schema } from 'effect';

// Local imports
import { getRunRecords } from '@agent/storage/runRecords';
import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import type { ResumeTurnIdentity } from '@agent/runtime/executeAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RegisterRunOptions } from '@agent/storage/runLifecycle';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import type { AgentRunServices } from '@agent/runtime/runRegistry';
import {
  createNativeSubagentStrategy,
  type ChildRunLaunchOptions,
} from '@agent/runtime/nativeSubagentStrategy';
import { withLogChannel } from '@logger/effectLog';
import type { ApprovalGrants } from '@shared/approvalBypassKind';
import {
  AgentConfigSchema,
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { startDetachedChildRunLoop } from './detachedChildRun';

const CHANNEL = 'inBandSubagentRun';

/**
 * A required-result child left no typed result to read back: the
 * infrastructure failed before or around the child's terminal persistence.
 * Kept distinct from the child's own failure, which is an ordinary failed
 * call, because a durability fault must abort the caller's run instead of
 * returning a null value to it.
 */
export class SubagentDurabilityError extends Schema.TaggedError<SubagentDurabilityError>()(
  'SubagentDurabilityError',
  // What failed under the fault rides as `Error.cause`, after the sentence.
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

interface InBandSubagentRunBaseOptions extends ChildRunLaunchOptions {
  /** The run this attempt executes under; the caller owns its derivation. */
  readonly runId: RunId;
  /** The parent's tool card whose call launches the child. */
  readonly parentCard?: string;
  /** That call's id, which owns the child. */
  readonly parentCallId?: string;
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
  | { readonly kind: 'resume'; readonly identity: ResumeTurnIdentity };

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

/** The squashed cause of a failed exit; none for a success. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

/** A fresh child's registration, as the call that launches it owns it. */
const registrationOf = (
  options: InBandSubagentRunBaseOptions,
  agent: string,
): RegisterRunOptions => ({
  identity: { kind: 'agent', agent },
  userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
  parentRunId: options.parentRunId,
  ...(options.parentCard !== undefined && { parentCard: options.parentCard }),
  ...(options.parentCallId !== undefined && {
    parentCallId: options.parentCallId,
  }),
  ...(options.grants !== undefined && { grants: options.grants }),
});

/**
 * Fail unless the child's `run.result` row landed. The caller answers a call
 * whose recovery reads that row, so the in-memory manifest is not enough: a
 * completed run whose manifest never landed is precisely what recovery
 * refuses to repeat, so the write is verified here, where the failure can
 * still be named. A read failure stays distinct from an absent row so the
 * error blames the I/O cause rather than persistence.
 */
const requirePersistedResult = Effect.fn('requirePersistedResult')(function* (
  session: SessionHandle,
  runId: RunId,
  childFailed: boolean,
  childError: () => unknown,
) {
  const persistedExit = yield* Effect.exit(
    getRunRecords(session, runId).readResultMeta(),
  );
  const readFailure = failureOf(persistedExit);
  if (readFailure !== undefined)
    yield* Effect.logWarning(
      'Failed to read the persisted result manifest',
    ).pipe(
      Effect.annotateLogs({ data: { runId, error: readFailure } }),
      withLogChannel(CHANNEL),
    );
  if (Option.getOrNull(Exit.getSuccess(persistedExit)) !== null) return;
  if (childFailed) {
    const error = childError();
    return yield* new SubagentDurabilityError({
      message: `Subagent ${runId} failed (${toErrorMessage(error)}), and its failure result could not be persisted.`,
      cause: new AggregateError(
        readFailure === undefined ? [error] : [error, readFailure],
        `Subagent ${runId} run and persistence both failed.`,
      ),
    });
  }
  return yield* new SubagentDurabilityError({
    message:
      readFailure === undefined
        ? `Failed to persist result for subagent ${runId}.`
        : `Failed to verify the persisted result for subagent ${runId}.`,
    cause: readFailure,
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
 * - completion rejected, or no finished typed result / no `run.end` row
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
      launch.kind === 'fresh'
        ? launch.definition.config
        : launch.identity.agentConfig;
    const startedAt = yield* Clock.currentTimeMillis;
    const workingDirectory = config.workingDirectory ?? undefined;
    const { fiber, lastTurn } = yield* startDetachedChildRunLoop({
      session: options.session,
      runId,
      parentRunId: options.parentRunId,
      agentName: config.agent,
      // The parent is blocked awaiting this child, so it rides the parent's
      // budget slot (child-run budget design note).
      awaited: true,
      ...(options.notify !== undefined && { notify: options.notify }),
      // Built inside the loop's launch guard, like every attempt-scoped
      // setup: a throw here ends the run and releases its claim.
      buildLaunch: () =>
        Effect.succeed(
          createNativeSubagentStrategy({
            ...options,
            ...(launch.kind === 'fresh'
              ? {
                  definition: launch.definition,
                  // Registered with its opening, which the child's run
                  // commits as it starts.
                  registration: registrationOf(options, config.agent),
                }
              : {
                  resume: {
                    identity: launch.identity,
                    options: { session: options.session },
                  },
                }),
            runId,
            startedAt,
            workingDirectory,
            inBand: true,
          }),
        ),
    });

    const completionExit = yield* Effect.exit(Fiber.join(fiber));
    const loopFailure = failureOf(completionExit);

    // The turn the child ended with, as its loop recorded it; none means
    // the run was interrupted, or a delivery write or the infrastructure
    // failed before terminal persistence.
    const finished = lastTurn();
    const resultMeta = finished?.resultMeta;
    if (!finished || !resultMeta || resultMeta.producer !== 'subagent') {
      return yield* new SubagentDurabilityError({
        message: `Subagent ${runId} ended without a finished typed result (interrupted before terminal persistence, or the run loop failed).`,
        cause: loopFailure,
      });
    }

    // How the child ended is the `run.end` row's fact, written by the run's
    // own lifecycle; the manifest carries only the output as this turn's
    // delivery enriched it. A read failure is kept apart from an absent row
    // so the thrown error can name the I/O cause.
    const endExit = yield* Effect.exit(
      getRunRecords(options.session, runId).readRunEnd(),
    );
    const runEnd = Option.getOrNull(Exit.getSuccess(endExit));
    const endFailure = failureOf(endExit);
    if (endFailure !== undefined)
      yield* Effect.logWarning('Failed to read the terminal run fact').pipe(
        Effect.annotateLogs({ data: { runId, error: endFailure } }),
        withLogChannel(CHANNEL),
      );
    const childFailed =
      finished.isError || runEnd?.outcome === RUN_OUTCOME.FAILED;
    // The raw application error when the turn threw; otherwise the terminal
    // row's own structured error (the result-only contract).
    const childError = () =>
      finished.error ??
      new Error(
        runEnd?.error?.message ??
          `Subagent ${runId} ended with failed outcome.`,
      );

    yield* requirePersistedResult(
      options.session,
      runId,
      childFailed,
      childError,
    );

    if (childFailed) return yield* Effect.fail(ensureError(childError()));

    if (!runEnd) {
      // The child did not fail, so the missing terminal row is an
      // infrastructure gap: the run's lifecycle never committed it, or the
      // read of it failed.
      return yield* new SubagentDurabilityError({
        message: `Subagent ${runId} ended without a terminal record.`,
        cause: endFailure,
      });
    }

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
        session: options.session,
        suppressErrorNotification: true,
      });
      return yield* executeInBand(options, { kind: 'fresh', definition });
    }).pipe(defectsAsErrors),
  );

/**
 * Resume a persisted child under the run id it already has and await it as
 * {@link executeSubagentInBand} awaits a launch: the child continues where
 * its last owner stopped, in one cycle, and its typed result is read back
 * from the record. Its stored configuration is what it runs under.
 */
export const resumeSubagentInBand = (
  options: InBandSubagentRunBaseOptions,
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
      return yield* executeInBand(options, {
        kind: 'resume',
        identity: { runId: options.runId, agentConfig },
      });
    }).pipe(defectsAsErrors),
  );

/** Await one in-band child's program; interrupting the caller stops the
 *  child by its run id and waits for it to write its own record. */
const awaitInBand = Effect.fn('inBandSubagentRun.awaitInBand')(function* (
  runId: RunId,
  program: Effect.Effect<InBandSubagentRunResult, Error, AgentRunServices>,
): Effect.fn.Return<InBandSubagentRunResult, Error, AgentRunServices> {
  const runs = registryOf(yield* Runs);
  const child = yield* Effect.forkChild(program, { startImmediately: true });
  return yield* Fiber.join(child).pipe(
    Effect.onInterrupt(() =>
      Effect.suspend(() =>
        runs.interruptActive(runId)
          ? Fiber.await(child)
          : // No run to stop yet: a loop the launch's hand-off started
            // meanwhile is stopped once it returns, and awaited to the end.
            Fiber.interrupt(child).pipe(
              Effect.andThen(Effect.sync(() => runs.interruptActive(runId))),
              Effect.andThen(runs.awaitDrained(runId)),
            ),
      ),
    ),
  );
});
