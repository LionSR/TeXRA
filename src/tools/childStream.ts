// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  AgentExecutionHandle,
  trackExecution,
  untrackExecution,
} from '@agent/runtime/executionRegistry';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';

// Local imports - errors
import { toErrorMessage } from '@common/errors';
import type { TexraTrace } from '@logger';

// Local imports - logger
import { createRunTrace } from '@logger';

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

/** Create a child stream tab and execution handle for a background child task. */
export function createChildStream(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  options: CreateChildStreamOptions,
): { childStreamId: StreamTabId; logger: TexraTrace } {
  const childStreamId = `${options.streamPrefix}#${executionId}` as StreamTabId;
  const { runtimeHost } = options;

  StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING, {
    runtimeHost,
  });
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

  const logger = createRunTrace(childStreamId).trace;
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    options.agentName,
    'toolUse',
    runtimeHost,
  );
  if (options.toolName) handle.toolName = options.toolName;
  trackExecution(handle);

  return { childStreamId, logger };
}

/** Finalize a child stream tab and untrack its execution handle. */
export function finalizeChildStream(
  childStreamId: StreamTabId,
  executionId: ExecutionId,
  logger: TexraTrace,
  runtimeHost: AgentRuntimeHost,
  options?: FinalizeChildStreamOptions,
): void {
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

  // Preserve user-initiated STOPPED status — don't overwrite with ERROR/READY
  const currentStatus = StreamStatusService.get(childStreamId);
  if (currentStatus !== STREAM_STATUS.STOPPED) {
    StreamStatusService.set(
      childStreamId,
      hasError ? STREAM_STATUS.ERROR : STREAM_STATUS.READY,
      { runtimeHost },
    );
  }
  untrackExecution(executionId);

  if (options?.autoClose) {
    runtimeHost.emit('removeStream', { streamId: childStreamId });
  }
}
