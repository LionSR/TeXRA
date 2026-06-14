// Local imports - agent
import { createRunTrace } from '@transcript';
import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';

// Local imports - errors
import { toErrorMessage } from '@common/errors';

// Local imports - shared
import type { ExecutionId, StreamTabId, StorageKey } from '@shared/schemas';
import { STREAM_STATUS } from '@shared/schemas';

// Local imports - utils
import { formatDuration } from '@utils/core';
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
  | typeof STREAM_STATUS.ERROR;

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

  // Register the child stream (state, logs, hints) without switching the
  // active tab. Background child streams (bash, codex) shouldn't yank the
  // user away from whatever they're viewing — the tab simply appears.
  runtimeHost.emit('setActiveStream', {
    streamId: childStreamId,
    agentCategory: options.streamCategory,
    suppressViewSwitch: true,
  });
  runtimeHost.emit('setTaskState', {
    streamId: childStreamId,
    executionId,
    taskState: agentConfigToTaskState(options.config),
  });
  runtimeHost.emit('updateStreamDescription', {
    streamId: childStreamId,
    description: truncateWithEllipsis(options.description, 80),
  });

  // Capture the run's session at creation (inside the parent run's ALS); the
  // status-update and finalize closures below fire later, possibly outside it.
  const session = currentSession();
  const runTrace = createRunTrace(childStreamId, undefined, session.flushers);
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    options.agentName,
    'toolUse',
    runtimeHost,
  );
  if (options.toolName) handle.toolName = options.toolName;
  session.executions.trackAgentExecution(handle, {
    status: STREAM_STATUS.RUNNING,
  });

  return {
    childStreamId,
    logger: runTrace.trace,
    // Mid-run status updates are intentionally best-effort. Explicit stops and
    // stale handles are ignored by the registry; finalize owns terminal status.
    waitForInput: () => {
      session.executions.updateAgentExecutionStatus(
        handle,
        STREAM_STATUS.WAITING,
      );
    },
    beginTurn: () => {
      session.executions.updateAgentExecutionStatus(
        handle,
        STREAM_STATUS.RUNNING,
      );
    },
    failTurn: () => {
      session.executions.updateAgentExecutionStatus(
        handle,
        STREAM_STATUS.ERROR,
      );
    },
    finalize: (finalizeOptions) => {
      finalizeChildStream({
        handle,
        session,
        logger: runTrace.trace,
        disposeTrace: runTrace.dispose,
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

  if (options?.errorMessage) {
    logger.error(options.errorMessage);
  } else if (options?.error) {
    logger.error(toErrorMessage(options.error));
  }
  if (options?.wallTimeMs != null) {
    logger.info(`Completed in ${formatDuration(options.wallTimeMs)}`);
  }
  if (options?.usage) {
    logger.info(
      `Tokens: ${options.usage.input_tokens} in / ${options.usage.output_tokens} out`,
    );
  }

  session.executions.finishAgentExecution(handle, {
    status:
      options?.status ?? (hasError ? STREAM_STATUS.ERROR : STREAM_STATUS.READY),
  });
  disposeTrace();

  if (options?.autoClose) {
    handle.runtimeHost.emit('removeStream', { streamId: handle.childStreamId });
  }
}
