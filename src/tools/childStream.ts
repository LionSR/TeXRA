// Local imports - agent
import { createRunTrace } from '@transcript';
import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';

// Local imports - errors
import { classifyAgentError } from '@common/errors';

// Local imports - constants
import { deriveRunOutcome } from '@common/constants/streamStatus';

// Local imports - shared
import type { ExecutionId, StreamTabId, StorageKey } from '@shared/schemas';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_STATUS,
  buildRunDescriptor,
} from '@shared/schemas';

// Local imports - utils
import { formatDuration } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

interface CreateChildStreamOptions {
  runtimeHost: AgentRuntimeHost;
  streamPrefix: string;
  streamCategory: AgentCategory;
  agentName: string;
  description: string;
  config: AgentConfig;
  /** Tool that spawned this child (e.g. "bash", "codex"). Used for icon selection in the UI. */
  toolName?: string;
}

interface FinalizeChildStreamOptions {
  wallTimeMs?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  } | null;
  error?: unknown;
  errorMessage?: string;
  status?: ChildStreamTerminalStatus;
  /** Remove the child stream tab from the progress view once finalized. */
  autoClose?: boolean;
}

type ChildStreamTerminalStatus =
  | typeof STREAM_STATUS.READY
  | typeof STREAM_STATUS.ERROR
  | typeof STREAM_STATUS.STOPPED;

export interface ChildStream {
  childStreamId: StreamTabId;
  logger: AgentTrace;
  /** The child loop is idle and waiting for the next follow-up instruction. */
  waitForInput: () => void;
  /** The child loop has started processing a turn. */
  beginTurn: () => void;
  /** The active turn failed; preserve explicit user stops. */
  failTurn: () => void;
  /** Complete the child stream lifecycle through the owning execution handle. */
  finalize: (options?: FinalizeChildStreamOptions) => void;
}

/** Create a child stream tab and execution handle for a background child task. */
export function createChildStream(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  options: CreateChildStreamOptions,
): ChildStream {
  const childStreamId = `${options.streamPrefix}#${executionId}` as StreamTabId;
  const { runtimeHost } = options;

  // Capture the run's session at creation (inside the parent run's ALS); the
  // status-update and finalize closures below fire later, possibly outside it.
  const session = currentSession();
  const runTrace = createRunTrace(
    childStreamId,
    session.transcripts,
    session.flushers,
  );
  const detachSessionTrace = session.attachRunTrace(
    runTrace.trace,
    childStreamId,
  );
  const disposeTrace = () => {
    detachSessionTrace();
    runTrace.dispose();
  };
  session.events.assertRunSubscribersAttachedBeforeActivation(childStreamId);

  // Register the child stream (state, logs, hints) without switching the
  // active tab. Background child streams (bash, codex) shouldn't yank the
  // user away from whatever they're viewing — the tab simply appears.
  runtimeHost.emit('setActiveStream', {
    streamId: childStreamId,
    agentCategory: options.streamCategory,
    suppressViewSwitch: true,
  });
  runTrace.trace.emit({
    type: 'run.start',
    descriptor: buildRunDescriptor({
      streamId: childStreamId,
      executionId,
      agent: options.config.agent,
      category: options.config.agentCategory,
    }),
  });
  runtimeHost.emit('setTaskState', {
    streamId: childStreamId,
    executionId,
    taskState: agentConfigToTaskState(options.config),
  });
  emitRuntimeEvent(
    'updateStreamDescription',
    {
      streamId: childStreamId,
      description: truncateWithEllipsis(options.description, 80),
    },
    session,
  );

  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    options.agentName,
    'toolUse',
    runtimeHost,
    runTrace.trace,
  );
  if (options.toolName) handle.toolName = options.toolName;
  session.executions.trackAgentExecution(handle, {
    status: STREAM_PHASE.RUNNING,
  });

  return {
    childStreamId,
    logger: runTrace.trace,
    // Mid-run status updates are intentionally best-effort. Explicit stops and
    // stale handles are ignored by the registry; finalize owns terminal status.
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
    finalize: (finalizeOptions) => {
      finalizeChildStream({
        handle,
        session,
        logger: runTrace.trace,
        disposeTrace,
        options: finalizeOptions,
      });
    },
  };
}

interface FinalizeChildStreamArgs {
  handle: AgentExecutionHandle;
  session: SessionHandle;
  logger: AgentTrace;
  disposeTrace: () => void;
  options?: FinalizeChildStreamOptions;
}

/** Finalize a child stream tab and untrack its execution handle. */
function finalizeChildStream(args: FinalizeChildStreamArgs): void {
  const { handle, session, logger, disposeTrace, options } = args;
  const hasError = options?.error != null || options?.errorMessage != null;
  const errorMessage =
    options?.errorMessage ??
    (options?.error != null ? toErrorMessage(options.error) : undefined);

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

  // The terminal status the child finishes with — the single source of truth
  // for both the registry status and the handle's result outcome. Deriving from
  // status (not just `hasError`) covers callers that pass ERROR without an
  // error payload, and long-lived child loops that finalize after an interrupt.
  const requestedStatus =
    options?.status ?? (hasError ? STREAM_STATUS.ERROR : STREAM_STATUS.READY);
  const currentStatus = session.executions.getStatus(handle).status;
  let finalStatus: ChildStreamTerminalStatus;
  if (
    currentStatus === STREAM_PHASE.CANCELLED ||
    requestedStatus === STREAM_STATUS.STOPPED
  ) {
    finalStatus = STREAM_STATUS.STOPPED;
  } else if (hasError) {
    finalStatus = STREAM_STATUS.ERROR;
  } else {
    finalStatus = requestedStatus;
  }
  const outcome = deriveRunOutcome({
    failed: finalStatus === STREAM_STATUS.ERROR,
    cancelled: finalStatus === STREAM_STATUS.STOPPED,
  });
  const error =
    outcome === 'failed'
      ? {
          kind: classifyAgentError(options?.error),
          message: errorMessage ?? 'Child stream failed',
        }
      : undefined;

  // Settle the handle's `result` before untracking (F-2): child streams never
  // traverse the run lifecycle, so this is their only settle point. Without it
  // a consumer awaiting a child handle's `result` would hang forever.
  handle.settleResult({
    type: 'result',
    outcome,
    executionId: handle.executionId,
    streamId: handle.childStreamId,
    agentName: handle.agentName,
    category: handle.category,
    isSubagent: handle.parentStreamId !== handle.childStreamId,
    ...(error ? { error } : {}),
  });

  session.executions.finishAgentExecution(handle, {
    status:
      outcome === RUN_OUTCOME.FAILED
        ? STREAM_PHASE.FAILED
        : outcome === RUN_OUTCOME.CANCELLED
          ? STREAM_PHASE.CANCELLED
          : STREAM_PHASE.COMPLETED,
  });
  disposeTrace();

  if (options?.autoClose) {
    const handled = handle.runtimeHost.interactions?.handleProgressEvent(
      'removeStream',
      { streamId: handle.childStreamId },
    );
    if (!handled) {
      handle.runtimeHost.emit('removeStream', {
        streamId: handle.childStreamId,
      });
    }
  }
}
