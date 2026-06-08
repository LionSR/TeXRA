// Local imports - agent
import { createRunTrace } from '@transcript';
import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  AgentExecutionHandle,
  executionRegistry,
} from '@agent/runtime/executionRegistry';
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
  /** Remove the child stream tab from the progress view once finalized. */
  autoClose?: boolean;
}

export interface ChildStream {
  childStreamId: StreamTabId;
  logger: AgentTrace;
  /**
   * Drop the run-trace subscribers attached by `createRunTrace`. Must be
   * called once when a custom child-loop cleanup path does not use `finalize`.
   */
  disposeTrace: () => void;
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

  const runTrace = createRunTrace(childStreamId);
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    options.agentName,
    'toolUse',
    runtimeHost,
  );
  if (options.toolName) handle.toolName = options.toolName;
  executionRegistry.trackAgentExecution(handle, {
    status: STREAM_STATUS.RUNNING,
  });

  return {
    childStreamId,
    logger: runTrace.trace,
    disposeTrace: runTrace.dispose,
    finalize: (finalizeOptions) => {
      finalizeChildStream({
        handle,
        logger: runTrace.trace,
        disposeTrace: runTrace.dispose,
        options: finalizeOptions,
      });
    },
  };
}

interface FinalizeChildStreamArgs {
  handle: AgentExecutionHandle;
  logger: AgentTrace;
  disposeTrace: () => void;
  options?: FinalizeChildStreamOptions;
}

/** Finalize a child stream tab and untrack its execution handle. */
function finalizeChildStream(args: FinalizeChildStreamArgs): void {
  const { handle, logger, disposeTrace, options } = args;
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

  executionRegistry.finishAgentExecution(handle, {
    status: hasError ? STREAM_STATUS.ERROR : STREAM_STATUS.READY,
  });
  disposeTrace();

  if (options?.autoClose) {
    handle.runtimeHost.emit('removeStream', { streamId: handle.childStreamId });
  }
}
