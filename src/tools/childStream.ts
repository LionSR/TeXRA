// Local imports
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { captureOwnedExecutionLeaseIfPresent } from '@agent/storage/executionLease';
import {
  finalizeRunTerminal,
  type RunTerminalPersistence,
} from '@agent/runtime/AgentRunLifecycle';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { classifyAgentError } from '@common/errors';
import { STREAM_PHASE, buildRunDescriptor } from '@shared/schemas';
import type { ExecutionId, RunKind, StreamTabId } from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';
import { createRunTrace } from '@transcript';
import type { TranscriptWriter } from '@transcript/StreamLogStore';
import { formatDuration } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface CreateChildStreamOptions {
  streamPrefix: string;
  streamCategory: AgentCategory;
  runKind: RunKind;
  agentName: string;
  description: string;
  config: AgentConfig;
  /** Tool that spawned this child (e.g. "bash", "codex"). Used for icon selection in the UI. */
  toolName?: string;
  /** Writer atomically reserved by createRehydratedChildStream. */
  reservedWriter?: TranscriptWriter;
}

/**
 * What the child observed about its own exit. It is a report, not a verdict:
 * the stream phase owns the terminal outcome, so an explicit stop/kill that
 * already landed CANCELLED outranks the non-zero exit it caused.
 */
export type ChildStreamOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error?: unknown; errorMessage?: string }
  | { kind: 'cancelled' };

interface FinalizeChildStreamOptions {
  wallTimeMs?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  } | null;
  /** Defaults to `{ kind: 'completed' }` when omitted. */
  outcome?: ChildStreamOutcome;
  /** Session stage closed with the derived outcome (agent-CLI loop's stage). */
  stage?: Pick<StageHandle, 'end'>;
  /** Durable execution-state action; background bash owns its richer block. */
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
  finalize: (options?: FinalizeChildStreamOptions) => Promise<void>;
}

/** Derive the durable stream identity shared by registration and creation. */
export function getChildStreamId(
  executionId: ExecutionId,
  streamPrefix: string,
): StreamTabId {
  return `${streamPrefix}#${executionId}` as StreamTabId;
}

/** Create a child stream tab and execution handle for a background child task. */
export function createChildStream(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  options: CreateChildStreamOptions,
): ChildStream {
  const childStreamId = getChildStreamId(executionId, options.streamPrefix);

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
  let detachSessionTrace: (() => void) | undefined;
  try {
    detachSessionTrace = session.attachRunTrace(runTrace.trace, childStreamId);
    const disposeTrace = () => {
      detachSessionTrace?.();
      runTrace.dispose();
    };
    session.events.assertRunSubscribersAttachedBeforeActivation(childStreamId);

    runTrace.trace.emit({
      type: 'run.start',
      descriptor: buildRunDescriptor({
        streamId: childStreamId,
        executionId,
        agent: options.agentName,
        category: options.streamCategory,
        kind: options.runKind,
      }),
    });
    runTrace.trace.emit({
      type: 'run.config',
      streamId: childStreamId,
      executionId,
      config: options.config,
    });
    const description = truncateWithEllipsis(options.description, 80);
    session.events.emit({
      scope: 'session',
      event: {
        type: 'updateStreamDescription',
        payload: {
          streamId: childStreamId,
          description,
        },
      },
    });

    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      options.agentName,
      options.streamCategory,
      runTrace.trace,
    );
    const executionLeaseScope =
      captureOwnedExecutionLeaseIfPresent(executionId);
    if (executionLeaseScope) {
      handle.attachExecutionLeaseScope(executionLeaseScope);
    }
    if (options.toolName) handle.toolName = options.toolName;
    // The process-owned snapshot listener persists both facts before handle
    // tracking; a later presentation replays them from the snapshot store during
    // canonical state loading (#8258).
    session.executions.trackAgentExecution(handle, {
      status: STREAM_PHASE.RUNNING,
    });

    // Make the child visible only after every fallible setup step succeeds.
    // removeStream permanently tombstones deterministic IDs in the CLI, so a
    // presentation rollback cannot safely clean up a partially created tab.
    // Background child streams appear without switching the active tab.
    session.events.emit({
      scope: 'session',
      event: {
        type: 'setActiveStream',
        payload: {
          streamId: childStreamId,
          agentCategory: options.streamCategory,
          suppressViewSwitch: true,
        },
      },
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
    const failures = [error];
    try {
      detachSessionTrace?.();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      runTrace.dispose();
    } catch (cleanupError) {
      failures.push(cleanupError);
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
  const childStreamId = `${options.streamPrefix}#${executionId}` as StreamTabId;
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
  options?: FinalizeChildStreamOptions;
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
  const outcomeOption = options?.outcome ?? { kind: 'completed' as const };
  const errorMessage =
    outcomeOption.kind === 'failed'
      ? (outcomeOption.errorMessage ??
        (outcomeOption.error != null
          ? toErrorMessage(outcomeOption.error)
          : undefined))
      : undefined;

  if (errorMessage) {
    logger.error(errorMessage);
  }
  if (options?.wallTimeMs != null) {
    logger.info(`Completed in ${formatDuration(options.wallTimeMs)}`);
  }
  if (options?.usage) {
    logger.info('Tokens', {
      data: {
        input: options.usage.input_tokens,
        output: options.usage.output_tokens,
      },
    });
  }

  // What the child saw, projected into the shared vocabulary. The stream phase
  // decides which of this and an already-landed stop is the run's terminal
  // fact; that resolution lives in `finalizeRunTerminal`.
  const outcome = deriveRunOutcome({
    failed: outcomeOption.kind === 'failed',
    cancelled: outcomeOption.kind === 'cancelled',
  });
  const error =
    outcomeOption.kind === 'failed'
      ? {
          kind: classifyAgentError(outcomeOption.error),
          message: errorMessage ?? 'Child stream failed',
        }
      : undefined;

  await finalizeRunTerminal({
    handle,
    executions: session.executions,
    streamStatus: session.status,
    outcome,
    error,
    isSubagent: handle.parentStreamId !== handle.childStreamId,
    stage: options?.stage,
    // No trace emit: child-stream results must stay out of `session.onResult`
    // (host toast) consumers — the loop already presents them as follow-ups.
    persistence: options?.persistence ?? { kind: 'skip' },
  });
  disposeTrace();

  if (options?.autoClose) {
    session.events.emit({
      scope: 'session',
      event: {
        type: 'removeStream',
        payload: { streamId: handle.childStreamId },
      },
    });
  }
}
