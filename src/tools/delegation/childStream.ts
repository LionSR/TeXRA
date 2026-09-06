// Local imports
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  finalizeRunTerminal,
  type RunTerminalPersistence,
} from '@agent/runtime/AgentRunLifecycle';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { getStreamTabId } from '@agent/runtime/streamTab';
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
import type { TranscriptWriter } from '@transcript/StreamLogStore';
import { launchWorktreeInfo } from '@utils/git/worktreeInfo';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface CreateChildStreamOptions {
  streamPrefix: string;
  /** What owns this stream — the launch site declares the truth once. */
  run: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupport;
  description: string;
  config: AgentConfig;
  /** Writer atomically reserved by createRehydratedChildStream. */
  reservedWriter?: TranscriptWriter;
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
  /** Remove the child stream tab from the progress view once finalized. */
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
  finalize: (options: FinalizeChildStreamOptions) => Promise<void>;
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
export function createChildStream(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  options: CreateChildStreamOptions,
): ChildStream {
  const childStreamId = getStreamTabId(options.streamPrefix, { executionId });

  // Capture the run's session at creation (inside the parent run's ALS); the
  // status-update and finalize closures below fire later, possibly outside it.
  const session = currentSession();
  const runTrace = createRunTrace(
    childStreamId,
    session.transcripts,
    session.flushers,
    executionId,
    options.reservedWriter,
  );
  let traceDisposed = false;
  const removeSpillFlusher = session.useArtifactFlusher(async () => {
    await runTrace.flushSpills();
    if (traceDisposed) removeSpillFlusher();
  });
  let detachSessionTrace: (() => void) | undefined;
  let started = false;
  try {
    // The trace's durable arms and the recorder's status port, one attachment.
    detachSessionTrace = session.attachRunTrace(runTrace, childStreamId);
    const disposeTrace = () => {
      traceDisposed = true;
      detachSessionTrace?.();
      runTrace.dispose();
    };

    // The existence fact and its activation, one batch on the session (PRD
    // one-fold-three-renderers, section 6, item 8): a child is activated
    // exactly once, here, and the frozen NDJSON `setActiveStream` line
    // projects from that. A background child never takes a host's focus:
    // which stream a surface shows is that surface's own selection, so the
    // fact carries no hint about it. `removeStream` permanently tombstones
    // deterministic IDs in the CLI, so every fallible setup step above ran
    // before this point; a failure here rolls back below without a fact.
    session.publish([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('stream', childStreamId),
        executionId,
        identity: options.run,
        userFollowUpSupport: options.userFollowUpSupport,
        // Launch facts the fold reads verbatim (item 6). Remoteness is an
        // agent-registry fact (a `source: 'remote'` entry); a process,
        // agent-CLI, or workflow-script child has no registry entry and is
        // never remote.
        category: options.config.agentCategory,
        isRemote: false,
        worktree: launchWorktreeInfo(options.config.workingDirectory),
        parentStreamId,
        background: true,
        // The initial policy snapshot (PRD 6, item 2). Approval ancestry for
        // the child is registered after this event by the delegation site;
        // the queue publishes `approval.policy` for every value the edge
        // changes.
        approvalPolicy: session.approvalPolicySnapshotFor(childStreamId),
        ...(options.checkpointId ? { checkpointId: options.checkpointId } : {}),
      },
      // No `isRemote`: the wire line never carried one for a child, which
      // has no agent-registry entry to be remote.
      {
        type: 'run.activate',
        aggregateId: qualifyAggregateId('stream', childStreamId),
        category: options.config.agentCategory,
        background: true,
      },
    ]);
    started = true;
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
    // The process-owned snapshot listener persists both facts before handle
    // tracking; a later presentation replays them from the snapshot store during
    // canonical state loading (#8258).
    session.executions.trackAgentExecution(handle, {
      status: STREAM_PHASE.RUNNING,
    });

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
    };
  } catch (error) {
    // Roll back every fallible setup step in reverse-ish order; a cleanup
    // failure must neither mask the original error nor skip later steps. A
    // stream that already published its `run.start` exists for every fold,
    // so it ends with its terminal `result` instead of lingering as a
    // started-but-never-run ghost; the child's result stays out of the host
    // result plane (`isSubagent`), as every child-stream result does.
    const failures: unknown[] = [error];
    const cleanups: (() => void)[] = [
      () => {
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
      },
      () => removeSpillFlusher(),
      () => detachSessionTrace?.(),
      () => runTrace.dispose(),
    ];
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Child stream setup and cleanup failed',
      );
    }
    throw error;
  }
}

/**
 * Reactivate a deterministic child stream whose prior trace may have released
 * its persisted transcript. Writer reservation and loading are atomic with
 * respect to eviction.
 */
export async function createRehydratedChildStream(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  options: CreateChildStreamOptions,
): Promise<ChildStream> {
  const session = currentSession();
  const childStreamId = getStreamTabId(options.streamPrefix, { executionId });
  const writer = await session.transcripts.loadAndAcquireWriter(
    childStreamId,
    executionId,
  );
  try {
    return createChildStream(executionId, parentStreamId, {
      ...options,
      reservedWriter: writer,
    });
  } catch (error) {
    writer.close();
    throw error;
  }
}

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
 * stream phase) and the autoClose emit. Child streams never traverse the run
 * lifecycle, so this is their only settle point.
 */
async function finalizeChildStream(
  args: FinalizeChildStreamArgs,
): Promise<void> {
  const { handle, session, logger, disposeTrace, options } = args;

  // The failure prologue (error formatting, logging, classification) is
  // fallible. It must never prevent `finalizeRunTerminal` below from running:
  // a throw here, past `claimTerminalFinalize`'s exactly-once guard, would
  // otherwise strand the handle in the registry forever with no untrack.
  let outcome: RunOutcome;
  let error: Parameters<typeof finalizeRunTerminal>[0]['error'];
  try {
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
  } catch (prologueError) {
    logger.error('Child stream finalize prologue failed', {
      data: { error: prologueError },
    });
    outcome = RUN_OUTCOME.FAILED;
    error = {
      kind: 'unexpected',
      message: 'Child stream finalize prologue failed',
    };
  }

  await finalizeRunTerminal({
    handle,
    executions: session.executions,
    streamStatus: session.status,
    outcome,
    error,
    isSubagent: handle.isChildExecution,
    stage: options.stage,
    flushArtifacts: () => session.flushArtifacts(handle.executionId),
    // No trace emit: child-stream results must stay out of `session.onResult`
    // (host toast) consumers — the loop already presents them as follow-ups.
    persistence: options.persistence ?? { kind: 'skip' },
  });
  disposeTrace();

  if (options.autoClose) {
    session.publish([
      {
        type: 'stream.removed',
        aggregateId: qualifyAggregateId('stream', handle.childStreamId),
      },
    ]);
  }
}
