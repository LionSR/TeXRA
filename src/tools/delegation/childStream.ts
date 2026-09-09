// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  finalizeRunTerminal,
  type RunTerminalPersistence,
} from '@agent/runtime/AgentRunLifecycle';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { runInSession } from '@agent/runtime/RunContext';
import { classifyAgentError } from '@common/errors';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  STREAM_PHASE,
} from '@shared/schemas';
import type {
  ExecutionId,
  RunIdentity,
  RunOutcome,
  StreamTabId,
  UserFollowUpSupport,
} from '@shared/schemas';
import { createRunTrace } from '@transcript';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

interface CreateChildStreamOptions {
  streamPrefix: string;
  /** What owns this stream — the launch site declares the truth once. */
  run: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupport;
  description: string;
  config: AgentConfig;
  /** A workflow-script run's resume anchor, stamped on `run.start`
   *  (decision 9): the checkpoint it journals into. */
  checkpointId?: string;
}

interface FinalizeChildStreamOptions {
  /**
   * The child's report of its own exit. A report, not a verdict: the stream
   * phase owns the terminal outcome, so an explicit stop/kill that already
   * landed CANCELLED outranks a FAILED this reports.
   */
  outcome: RunOutcome;
  /** Cause behind a FAILED outcome, for diagnosis. */
  error?: unknown;
  /** Session stage closed with the derived outcome (agent-CLI loop's stage). */
  stage?: Pick<StageHandle, 'end'>;
  /** Durable execution-state action. */
  persistence?: RunTerminalPersistence;
  /** Release completed transcript residency while preserving command history. */
  autoClose?: boolean;
}

export interface ChildStream {
  childStreamId: StreamTabId;
  logger: AgentTrace;
  /** The child loop is idle and waiting for the next follow-up instruction. */
  waitForInput: () => void;
  /** The child loop has started processing a turn. */
  beginTurn: () => void;
  /** The active turn failed; preserve explicit user stops. */
  failTurn: () => void;
  /**
   * Complete the child stream lifecycle through the owning execution handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked — callers that must not exit before the terminal status lands
   * (headless CLI session loops) await it.
   */
  finalize: (options: FinalizeChildStreamOptions) => Effect.Effect<void, Error>;
}

/**
 * Normalize a child task's raw label to the ≤80-char display description.
 * Single owner of that cap for both the durable authority write
 * (`registerExecution`'s `description` → `ExecutionMeta.description`, #9590
 * A4) and the display-only `updateStreamDescription` event below, so the
 * persisted and live values can never drift.
 */
export function childStreamDescription(raw: string): string {
  return truncateWithEllipsis(raw, 80);
}

/** Create a child stream tab and execution handle for a background child task. */
export const createChildStream = Effect.fn('createChildStream')(function* (
  session: SessionHandle,
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  options: CreateChildStreamOptions,
): Effect.fn.Return<ChildStream, Error> {
  const childStreamId = getStreamTabId(options.streamPrefix, { executionId });

  yield* Effect.tryPromise({
    try: () => session.settlePublications(),
    catch: ensureError,
  });
  const residency = yield* session.transcripts.acquireRunResidency(
    childStreamId,
    executionId,
  );
  const runTrace = createRunTrace(childStreamId, residency);
  const handle = new AgentExecutionHandle(
    {
      streamId: childStreamId,
      executionId,
      identity: options.run,
      category: options.config.agentCategory,
    },
    parentStreamId,
    runTrace.trace,
  );
  let detachSessionTrace: (() => void) | undefined;
  let started = false;
  const setup = yield* Effect.exit(
    Effect.gen(function* () {
      // Attach the run's canonical event publication before activation.
      detachSessionTrace = session.attachRunTrace(runTrace, childStreamId);
      const disposeTrace = () => {
        detachSessionTrace?.();
        runTrace.dispose();
      };

      // Registration already committed the launch and activation together.
      started = true;
      // Register local ownership before awaiting the creation commit. The start
      // batch is already queued, so its first event still precedes handle facts.
      session.executions.trackAgentExecution(handle, {
        status: STREAM_PHASE.RUNNING,
      });
      yield* Effect.tryPromise({
        try: () => session.settlePublications(),
        catch: ensureError,
      });
      runTrace.trace.emit({
        type: 'run.config',
        streamId: childStreamId,
        executionId,
        config: options.config,
      });
      // Display-only fan-out: the durable copy is `ExecutionMeta.description`,
      // written by `registerExecution` before this stream exists (#9590 Stage 6).
      const description = childStreamDescription(options.description);
      session.publish([
        {
          type: 'updateStreamDescription',
          aggregateId: qualifyAggregateId('stream', childStreamId),
          description,
        },
      ]);

      return {
        childStreamId,
        logger: runTrace.trace,
        // Reports, not writes: the status machine's transition table decides
        // which of these lands, so a stale handle or a stream a stop already
        // cancelled simply keeps the phase it has.
        waitForInput: () => {
          session.executions.updateAgentExecutionStatus(
            handle,
            STREAM_PHASE.WAITING,
          );
        },
        beginTurn: () => {
          session.executions.updateAgentExecutionStatus(
            handle,
            STREAM_PHASE.RUNNING,
          );
        },
        failTurn: () => {
          session.executions.updateAgentExecutionStatus(
            handle,
            STREAM_PHASE.FAILED,
          );
        },
        finalize: (finalizeOptions) =>
          finalizeChildStream({
            handle,
            session,
            logger: runTrace.trace,
            disposeTrace,
            options: finalizeOptions,
          }),
      } satisfies ChildStream;
    }),
  );
  if (Exit.isFailure(setup)) {
    const error = Cause.squash(setup.cause);
    // Roll back every fallible setup step in reverse-ish order; a cleanup
    // failure must neither mask the original error nor skip later steps. A
    // stream that already published its `run.start` exists for every fold,
    // so it ends with its terminal `result` instead of lingering as a
    // started-but-never-run ghost; the child's result stays out of the host
    // result plane (`isSubagent`), as every child-stream result does.
    const failures: unknown[] = [error];
    const cleanups: Effect.Effect<unknown, Error>[] = [
      Effect.sync(() => {
        if (!started) return;
        runTrace.trace.emit({
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          executionId,
          streamId: childStreamId,
          agentName: options.config.agent,
          category: options.config.agentCategory,
          isSubagent: true,
          error: {
            kind: classifyAgentError(error),
            message: `Child stream setup failed: ${toErrorMessage(error)}`,
          },
        });
      }),
      Effect.tryPromise({
        try: () => session.settlePublications(),
        catch: ensureError,
      }),
      Effect.sync(() => {
        session.executions.untrackIfCurrent(handle);
      }),
      Effect.sync(() => detachSessionTrace?.()),
      Effect.sync(() => runTrace.dispose()),
    ];
    for (const cleanup of cleanups) {
      const cleaned = yield* Effect.exit(cleanup);
      if (Exit.isFailure(cleaned)) failures.push(Cause.squash(cleaned.cause));
    }
    if (failures.length > 1) {
      return yield* Effect.fail(
        new AggregateError(failures, 'Child stream setup and cleanup failed'),
      );
    }
    return yield* Effect.fail(ensureError(error));
  }
  return setup.value;
}, Effect.uninterruptible);

interface FinalizeChildStreamArgs {
  handle: AgentExecutionHandle;
  session: SessionHandle;
  logger: AgentTrace;
  disposeTrace: () => void;
  options: FinalizeChildStreamOptions;
}

/**
 * Finalize a child stream tab: presentation logging plus the child's report of
 * its own exit, then the shared terminal finalizer (settle, untrack, terminal
 * stream phase) and the autoClose residency release. Child streams never traverse the run
 * lifecycle, so this is their only settle point.
 */
const finalizeChildStream = Effect.fn('finalizeChildStream')(function* (
  args: FinalizeChildStreamArgs,
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
      // What the child saw, in the shared vocabulary. The stream phase decides
      // which of this and an already-landed stop is the run's terminal fact;
      // that resolution lives in `finalizeRunTerminal`.
      outcome = options.outcome;
      error = failed
        ? {
            kind: classifyAgentError(options.error),
            message: errorMessage ?? 'Child stream failed',
          }
        : undefined;
    }),
  );
  if (Exit.isFailure(prologue)) {
    logger.error('Child stream finalize prologue failed', {
      data: { error: Cause.squash(prologue.cause) },
    });
    outcome = RUN_OUTCOME.FAILED;
    error = {
      kind: 'unexpected',
      message: 'Child stream finalize prologue failed',
    };
  }

  yield* finalizeRunTerminal({
    session,
    handle,
    executions: session.executions,
    streamStatus: session.status,
    outcome,
    error,
    isSubagent: handle.isChildExecution,
    stage: options.stage,
    flushArtifacts: () => session.flushArtifacts(),
    // No trace emit: child-stream results must stay out of `session.onResult`
    // (host toast) consumers; the loop already presents them as follow-ups.
    persistence: options.persistence ?? { kind: 'skip' },
  });
  disposeTrace();

  if (options.autoClose) {
    session.transcripts.requestEviction(handle.childStreamId);
  }
}, Effect.uninterruptible);
