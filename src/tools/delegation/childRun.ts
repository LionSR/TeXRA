// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports
import { TraceEmitter, type AgentTrace, type StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import { finalizeRun } from '@agent/storage/runLifecycle';
import { RunHandle } from '@agent/runtime/RunHandle';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { classifyAgentError } from '@common/errors';
import { RUN_OUTCOME } from '@shared/schemas';
import type {
  RunId,
  RunIdentity,
  RunOutcome,
  UserFollowUpSupport,
} from '@shared/schemas';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

interface CreateChildRunOptions {
  /** What owns this run — the launch site declares the truth once. */
  run: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupport;
  description: string;
  config: AgentConfig;
  /** A workflow-script run's resume anchor, stamped on `run.start`
   *  (decision 9): the checkpoint it journals into. */
  checkpointId?: string;
}

interface FinalizeChildRunOptions {
  /**
   * The child's report of its own exit. A report, not a verdict: the run
   * phase owns the terminal outcome, so an explicit stop/kill that already
   * landed CANCELLED outranks a FAILED this reports.
   */
  outcome: RunOutcome;
  /** Cause behind a FAILED outcome, for diagnosis. */
  error?: unknown;
  /**
   * The loop's own stop observation: a stop that reached the child before
   * this finalize outranks the outcome report above — `finalizeRunTerminal`
   * resolves the row and the stage to CANCELLED and drops the error facts
   * the outranked failure classified.
   */
  stopped?: boolean;
  /** Session stage closed with the derived outcome (agent-CLI loop's stage). */
  stage?: Pick<StageHandle, 'end'>;
}

export interface ChildRun {
  childRunId: RunId;
  logger: AgentTrace;
  /**
   * Complete the child run lifecycle through the owning run handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked — callers that must not exit before the terminal status lands
   * (headless CLI session loops) await it.
   */
  finalize: (
    options: FinalizeChildRunOptions,
  ) => Effect.Effect<void, Error, Runs>;
}

/**
 * Normalize a child task's raw label to the ≤80-char description
 * `registerRun` writes as the run's one `run.description` row (#9590 A4).
 */
export function childRunDescription(raw: string): string {
  return truncateWithEllipsis(raw, 80);
}

/** Create a child run's presentation and handle for a background child task. */
export const createChildRun = Effect.fn('createChildRun')(function* (
  session: SessionHandle,
  runId: RunId,
  parentRunId: RunId,
  options: CreateChildRunOptions,
): Effect.fn.Return<ChildRun, Error, Runs> {
  // No barrier here: registration committed the launch and its activation
  // awaited (`registerRun`), and every write below is either awaited or this
  // run's own queued fact, which its own drain answers for. A session-wide
  // settle would instead report whatever session-scoped publication anyone
  // else queued and fail an otherwise sound launch over it.
  const runs = yield* Runs;
  const trace = new TraceEmitter();
  const handle = new RunHandle(
    {
      runId,
      identity: options.run,
      category: options.config.agentCategory,
    },
    parentRunId,
    trace,
  );
  let detachSessionTrace: (() => void) | undefined;
  let started = false;
  const setup = yield* Effect.exit(
    Effect.sync(() => {
      // Attach the run's canonical event publication before activation.
      detachSessionTrace = session.attachRunTrace(trace, runId);
      const disposeTrace = () => detachSessionTrace?.();

      // Registration already committed the launch and activation together.
      started = true;
      runs.track(handle);
      trace.emit({
        type: 'run.config',
        runId,
        config: options.config,
      });

      return {
        childRunId: runId,
        logger: trace,
        finalize: (finalizeOptions) =>
          finalizeChildRun({
            handle,
            session,
            logger: trace,
            disposeTrace,
            options: finalizeOptions,
          }),
      } satisfies ChildRun;
    }),
  );
  if (Exit.isFailure(setup)) {
    const error = Cause.squash(setup.cause);
    // Roll back every fallible setup step in reverse-ish order; a cleanup
    // failure must neither mask the original error nor skip later steps. A
    // run that already published its `run.start` exists for every fold,
    // so it ends with its `run.end` row instead of lingering as a
    // started-but-never-run ghost — written by the one terminal writer, whose
    // commit is awaited, so no barrier stands behind it.
    const failures: unknown[] = [error];
    const cleanups: Effect.Effect<unknown, Error>[] = [
      Effect.suspend(() =>
        started
          ? finalizeRun(session, {
              runId,
              outcome: RUN_OUTCOME.FAILED,
              error: {
                kind: classifyAgentError(error),
                message: `Child run setup failed: ${toErrorMessage(error)}`,
              },
            }).pipe(
              Effect.flatMap((finalization) =>
                finalization.ok
                  ? Effect.void
                  : Effect.fail(
                      new Error('Failed to persist the child run failure', {
                        cause: finalization.error,
                      }),
                    ),
              ),
            )
          : Effect.void,
      ),
      Effect.sync(() => {
        runs.untrackIfCurrent(handle);
      }),
      Effect.sync(() => detachSessionTrace?.()),
    ];
    for (const cleanup of cleanups) {
      const cleaned = yield* Effect.exit(cleanup);
      if (Exit.isFailure(cleaned)) failures.push(Cause.squash(cleaned.cause));
    }
    if (failures.length > 1) {
      return yield* Effect.fail(
        new AggregateError(failures, 'Child run setup and cleanup failed'),
      );
    }
    return yield* Effect.fail(ensureError(error));
  }
  return setup.value;
}, Effect.uninterruptible);

interface FinalizeChildRunArgs {
  handle: RunHandle;
  session: SessionHandle;
  logger: AgentTrace;
  disposeTrace: () => void;
  options: FinalizeChildRunOptions;
}

/**
 * Finalize a child run: presentation logging plus the child's report of
 * its own exit, then the shared terminal finalizer (settle, untrack, terminal
 * run phase). Child runs never traverse
 * the run lifecycle, so this is their only settle point.
 *
 * No `output` is passed, by rule rather than by omission: a child loop's
 * product is the per-turn delivery routed to its parent (and the result
 * manifest a strategy persists beside it), not a flow output. Its `run.end`
 * row therefore carries the category's empty output.
 */
const finalizeChildRun = Effect.fn('finalizeChildRun')(function* (
  args: FinalizeChildRunArgs,
) {
  const { handle, session, logger, disposeTrace, options } = args;

  // The failure prologue (error formatting, logging, classification) is
  // fallible. It must never prevent `finalizeRunTerminal` below from running:
  // a throw here, past `claimTerminalFinalize`'s exactly-once guard, would
  // otherwise strand the handle in the registry forever with no untrack.
  let outcome: RunOutcome = options.outcome;
  let error: Parameters<typeof finalizeRunTerminal>[0]['error'];
  const prologue = yield* Effect.exit(
    Effect.sync(() => {
      const failed = options.outcome === RUN_OUTCOME.FAILED;
      const errorMessage =
        failed && options.error != null
          ? toErrorMessage(options.error)
          : undefined;

      if (errorMessage) {
        logger.error(errorMessage);
      }
      // What the child saw, in the shared vocabulary. Which of this and an
      // already-landed stop is the run's terminal fact is decided upstream:
      // the loop derives the outcome from its own interrupted signal, and
      // `finalizeRunTerminal` applies that stop precedence.
      outcome = options.outcome;
      error = failed
        ? {
            kind: classifyAgentError(options.error),
            message: errorMessage ?? 'Child run failed',
          }
        : undefined;
    }),
  );
  if (Exit.isFailure(prologue)) {
    logger.error('Child run finalize prologue failed', {
      data: { error: Cause.squash(prologue.cause) },
    });
    outcome = RUN_OUTCOME.FAILED;
    error = {
      kind: 'unexpected',
      message: 'Child run finalize prologue failed',
    };
  }

  const finalized = yield* finalizeRunTerminal({
    session,
    handle,
    outcome,
    error,
    stage: options.stage,
    stopped: options.stopped,
  });
  disposeTrace();

  // The port's contract is "resolves once the terminal finalizer has
  // persisted": a `run.end` row that never wrote is this finalize's failure,
  // so the loop's cleanup aggregation fails the loop over it rather than
  // report a child whose terminal fact is gone.
  if (finalized?.persistFailure !== undefined) {
    return yield* Effect.fail(
      new Error(`Child run ${handle.runId} terminal state was not persisted`, {
        cause: finalized.persistFailure,
      }),
    );
  }
}, Effect.uninterruptible);
