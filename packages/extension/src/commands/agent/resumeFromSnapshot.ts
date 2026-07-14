/**
 * Snapshot-driven auto-resume entry point for the VS Code host.
 *
 * Used by:
 *   - `texra.sendFollowUp` (auto-resume when a follow-up lands on a
 *     WAITING / children_running stream).
 *   - `AgentResumePort.tryResumeStream` (inquiry continuation path).
 *
 * This is a thin adapter: the host-neutral {@link resolveAndResumeStream}
 * orchestrator owns the guard, retrieval, and tool-use/workflow branch; the
 * extension supplies only how it resolves persisted state and launches a run.
 */
import { createChannelTrace } from '@agent/trace';
import {
  isResumeInFlight,
  resolveAndResumeStream,
} from '@agent/runtime/resolveAndResumeStream';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamTabId } from '@shared/schemas';

import { runExecuteCommand } from './executeCommand';
import { resumeExtensionToolUseSnapshot } from './resumeCommand';

const logger = createChannelTrace('resumeFromSnapshot');

export { isResumeInFlight };

export function tryResumeFromSnapshot(streamId: StreamTabId): Promise<boolean> {
  return resolveAndResumeStream(streamId, {
    runtimeHost: extensionAgentRuntimeHost,
    // The extension runs on the default session for this host-path caller
    // (outside any run ALS), so its status plane is the same one every other
    // unmigrated default-session caller reads through `defaultSession()`.
    streamStatus: defaultSession().status,
    resolveResumeState: async (id) => {
      const progressState = ProgressViewProvider.getInstance()?.state;
      if (!progressState) {
        logger.warn(`No ProgressViewProvider found for stream: ${id}`);
        return undefined;
      }
      const executionId = progressState.snapshots.getExecutionId(id);
      const taskState = progressState.snapshots.getTaskState(id);
      if (!executionId) {
        logger.warn(`No execution ID found for stream: ${id}`);
        return undefined;
      }
      if (!taskState) {
        logger.warn(`No task state found for stream: ${id}`);
        return undefined;
      }
      const parentStreamId = progressState.snapshots.getParentStreamId(id);
      return {
        runState: taskState,
        executionId,
        ...(parentStreamId !== undefined && { parentStreamId }),
      };
    },
    resumeToolUseSnapshot: resumeExtensionToolUseSnapshot,
    executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
      runExecuteCommand({ config, executionId, modelHandlerCompatibilityKey }),
    reportFailure: (id, error) => {
      logger.error(`Failed to resume stream: ${id}`, { data: error });
    },
  });
}
