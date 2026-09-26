// Third-party imports
import { Effect } from 'effect';

// Local imports
import { TraceEmitter, type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import type { ChildRunPort } from '@agent/runtime/childRunLoop';
import { RunHandle } from '@agent/runtime/RunHandle';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { classifyAgentError } from '@common/errors';
import { RUN_OUTCOME } from '@shared/schemas';
import type { RunId, RunIdentity } from '@shared/schemas';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface CreateChildRunOptions {
  /** What owns this run — the launch site declares the truth once. */
  run: RunIdentity;
  config: AgentConfig;
}

/**
 * Normalize a child task's raw label to the ≤80-char description
 * `registerRun` writes as the run's one `run.description` row (#9590 A4).
 */
export function childRunDescription(raw: string): string {
  return truncateWithEllipsis(raw, 80);
}

/**
 * Create a child run's presentation and handle for a background child task.
 * Every launch site calls this inside `startDetachedChildRunLoop`, whose
 * owned-run launch guard owns a failed launch's compensation.
 */
export const createChildRun = Effect.fn('createChildRun')(function* (
  session: SessionHandle,
  runId: RunId,
  parentRunId: RunId,
  options: CreateChildRunOptions,
): Effect.fn.Return<ChildRunPort, never, Runs> {
  // No barrier here: registration committed the launch and its activation
  // awaited (`registerRun`), and every write below is either awaited or this
  // run's own queued fact, which its own drain answers for. A session-wide
  // settle would instead report whatever session-scoped publication anyone
  // else queued and fail an otherwise sound launch over it.
  const runs = yield* Runs;
  // The run's canonical event publication, from its first event: the trace
  // is built with the session as its sink, and closed with the run.
  const trace = new TraceEmitter((event) =>
    session.publishRunEvent(runId, event),
  );
  const handle = new RunHandle(
    {
      runId,
      identity: options.run,
      category: options.config.agentCategory,
    },
    parentRunId,
    trace,
  );
  // Registration already committed the launch and activation together. The
  // handle is tracked by the loop (`track`) once its stop target exists, so
  // a stop never finds this handle with nothing to interrupt.
  trace.emit({
    type: 'run.config',
    runId,
    config: options.config,
  });
  return {
    logger: trace,
    track: () => runs.track(handle),
    finalize: (finalizeOptions) =>
      finalizeChildRun({
        handle,
        session,
        logger: trace,
        closeTrace: () => trace.close(),
        options: finalizeOptions,
      }),
  } satisfies ChildRunPort;
});

interface FinalizeChildRunArgs {
  handle: RunHandle;
  session: SessionHandle;
  logger: AgentTrace;
  closeTrace: () => void;
  options: Parameters<ChildRunPort['finalize']>[0];
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
  const { handle, session, logger, closeTrace, options } = args;

  const failed = options.outcome === RUN_OUTCOME.FAILED;
  const errorMessage =
    failed && options.error != null ? toErrorMessage(options.error) : undefined;
  if (errorMessage) {
    logger.error(errorMessage);
  }

  // What the child saw, in the shared vocabulary. Which of this and an
  // already-landed stop is the run's terminal fact is decided upstream: the
  // loop derives the outcome from its own interrupted signal, and
  // `finalizeRunTerminal` applies that stop precedence.
  const finalized = yield* finalizeRunTerminal({
    session,
    handle,
    outcome: options.outcome,
    error: failed
      ? {
          kind: classifyAgentError(options.error),
          message: errorMessage ?? 'Child run failed',
        }
      : undefined,
    stage: options.stage,
    stopped: options.stopped,
  });
  closeTrace();

  // The port's contract is "resolves once the terminal finalizer has
  // persisted": a `run.end` row that never wrote is this finalize's failure,
  // so the loop's cleanup aggregation fails the loop over it rather than
  // report a child whose terminal fact is gone.
  if (finalized.persistFailure !== undefined) {
    return yield* Effect.fail(
      new Error(`Child run ${handle.runId} terminal state was not persisted`, {
        cause: finalized.persistFailure,
      }),
    );
  }
}, Effect.uninterruptible);
