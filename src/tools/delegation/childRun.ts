// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  finalizeRunTerminal,
  type RunTerminalPersistence,
} from '@agent/runtime/AgentRunLifecycle';
import { RunHandle } from '@agent/runtime/RunHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { classifyAgentError } from '@common/errors';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
} from '@shared/schemas';
import type {
  RunId,
  RunIdentity,
  RunOutcome,
  UserFollowUpSupport,
} from '@shared/schemas';
import { createRunTrace } from '@transcript';
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
  /** Session stage closed with the derived outcome (agent-CLI loop's stage). */
  stage?: Pick<StageHandle, 'end'>;
  /** Durable run-state action. */
  persistence?: RunTerminalPersistence;
  /** Release completed transcript residency while preserving command history. */
  autoClose?: boolean;
}

export interface ChildRun {
  childRunId: RunId;
  logger: AgentTrace;
  /** The child loop is idle and waiting for the next follow-up instruction. */
  waitForInput: () => void;
  /** The child loop has started processing a turn. */
  beginTurn: () => void;
  /** The active turn failed; preserve explicit user stops. */
  failTurn: () => void;
  /**
   * Complete the child run lifecycle through the owning run handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked — callers that must not exit before the terminal status lands
   * (headless CLI session loops) await it.
   */
  finalize: (options: FinalizeChildRunOptions) => Effect.Effect<void, Error>;
}

/**
 * Normalize a child task's raw label to the ≤80-char display description.
 * Single owner of that cap for both the durable authority write
 * (`registerRun`'s `description` → `RunMeta.description`, #9590
 * A4) and the display-only `updateRunDescription` event below, so the
 * persisted and live values can never drift.
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
): Effect.fn.Return<ChildRun, Error> {
  yield* Effect.tryPromise({
    try: () => session.settlePublications(),
    catch: ensureError,
  });
  const residency = yield* session.transcripts.acquireRunResidency(runId);
  const runTrace = createRunTrace(residency);
  const handle = new RunHandle(
    {
      runId,
      identity: options.run,
      category: options.config.agentCategory,
    },
    parentRunId,
    runTrace.trace,
  );
  let detachSessionTrace: (() => void) | undefined;
  let started = false;
  const setup = yield* Effect.exit(
    Effect.gen(function* () {
      // Attach the run's canonical event publication before activation.
      detachSessionTrace = session.attachRunTrace(runTrace.trace, runId);
      const disposeTrace = () => {
        detachSessionTrace?.();
        runTrace.dispose();
      };

      // Registration already committed the launch and activation together.
      started = true;
      // Register local ownership before awaiting the creation commit. The start
      // batch is already queued, so its first event still precedes handle facts.
      session.runs.trackAgentRun(handle, {
        status: RUN_PHASE.RUNNING,
      });
      yield* Effect.tryPromise({
        try: () => session.settlePublications(),
        catch: ensureError,
      });
      runTrace.trace.emit({
        type: 'run.config',
        runId,
        config: options.config,
      });
      // Display-only fan-out: the durable copy is `RunMeta.description`,
      // written by `registerRun` before this run exists (#9590 Stage 6).
      const description = childRunDescription(options.description);
      session.publish([
        {
          type: 'updateRunDescription',
          aggregateId: qualifyAggregateId('run', runId),
          description,
        },
      ]);

      return {
        childRunId: runId,
        logger: runTrace.trace,
        // Reports, not writes: the status machine's transition table decides
        // which of these lands, so a stale handle or a run a stop already
        // cancelled simply keeps the phase it has.
        waitForInput: () => {
          session.runs.updateAgentRunStatus(handle, RUN_PHASE.WAITING);
        },
        beginTurn: () => {
          session.runs.updateAgentRunStatus(handle, RUN_PHASE.RUNNING);
        },
        failTurn: () => {
          session.runs.updateAgentRunStatus(handle, RUN_PHASE.FAILED);
        },
        finalize: (finalizeOptions) =>
          finalizeChildRun({
            handle,
            session,
            logger: runTrace.trace,
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
    // so it ends with its terminal `result` instead of lingering as a
    // started-but-never-run ghost; the child's result stays out of the host
    // result plane (a child result), as every child-run result does.
    const failures: unknown[] = [error];
    const cleanups: Effect.Effect<unknown, Error>[] = [
      Effect.sync(() => {
        if (!started) return;
        runTrace.trace.emit({
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          runId,
          agentName: options.config.agent,
          category: options.config.agentCategory,
          error: {
            kind: classifyAgentError(error),
            message: `Child run setup failed: ${toErrorMessage(error)}`,
          },
        });
      }),
      Effect.tryPromise({
        try: () => session.settlePublications(),
        catch: ensureError,
      }),
      Effect.sync(() => {
        session.runs.untrackIfCurrent(handle);
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
 * run phase) and the autoClose residency release. Child runs never traverse
 * the run lifecycle, so this is their only settle point.
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
      // What the child saw, in the shared vocabulary. The run phase decides
      // which of this and an already-landed stop is the run's terminal fact;
      // that resolution lives in `finalizeRunTerminal`.
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

  yield* finalizeRunTerminal({
    session,
    handle,
    runs: session.runs,
    runStatus: session.status,
    outcome,
    error,
    stage: options.stage,
    flushArtifacts: () => session.flushArtifacts(),
    // No trace emit: child-run results must stay out of `session.onResult`
    // (host toast) consumers; the loop already presents them as follow-ups.
    persistence: options.persistence ?? { kind: 'skip' },
  });
  disposeTrace();

  if (options.autoClose) {
    session.transcripts.requestEviction(handle.runId);
  }
}, Effect.uninterruptible);
