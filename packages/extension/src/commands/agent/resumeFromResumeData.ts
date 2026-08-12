/**
 * Persisted-state auto-resume entry point for the VS Code host.
 *
 * Used by:
 *   - `texra.sendFollowUp` (auto-resume when a follow-up lands on a
 *     WAITING / children_running stream).
 *   - `AgentResumePort.tryResumeStream` (the progress view's Resume button on
 *     tool-use streams, and the inquiry continuation path).
 *
 * This is a thin adapter: the host-neutral {@link resolveAndResumeStream}
 * orchestrator owns the guard, retrieval, and tool-use/workflow branch; the
 * extension supplies only how it resolves persisted state and launches a run.
 */
import { createChannelTrace } from '@agent/trace';
import { defaultSession, resolveAndResumeStream } from '@agent/runtime';
import type { RecoveryContinuation } from '@platform/interfaces';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamTabId } from '@shared/schemas';

import { runExecuteCommand } from './executeCommand';
import { resumeExtensionToolUseFromResumeData } from './resumeCommand';

const logger = createChannelTrace('resumeFromResumeData');

export function tryResumeFromResumeData(
  streamId: StreamTabId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const session = defaultSession();
  const claimedRecovery = recovery
    ? session.followUps.useRecovery(recovery)
    : session.followUps.claimRecovery(streamId, true);
  if (!claimedRecovery) return Promise.resolve(false);
  return resolveAndResumeStream(
    streamId,
    {
      interactions: session.interactions,
      // The extension runs on the default session for this host-path caller
      // (outside any run ALS), so its status plane is the same one every other
      // unmigrated default-session caller reads through `defaultSession()`.
      streamStatus: session.status,
      // A stream deleted while asynchronous resume preparation runs must not be
      // resurrected by the resume that was already in flight.
      isCancellationRequested: () => !session.transcripts.has(streamId),
      resolveResumeState: async (id) => {
        const progressState = ProgressViewProvider.getInstance()?.state;
        if (!progressState) {
          logger.warn(`No ProgressViewProvider found for stream: ${id}`);
          return undefined;
        }
        let { config: runConfig, executionId } =
          progressState.snapshots.getRunMetadata(id);
        if (!runConfig || !executionId) {
          // Preload-then-read (#9947), mirroring the desktop resume path: a
          // stream whose sidecar record is not resident yet must be seeded
          // from disk before the synchronous reads can be trusted.
          try {
            await progressState.snapshots.preload([id]);
          } catch (error) {
            logger.warn(`Failed to read persisted resume data for ${id}`, {
              data: error,
            });
            return undefined;
          }
          ({ config: runConfig, executionId } =
            progressState.snapshots.getRunMetadata(id));
        }
        if (!executionId) {
          logger.warn(`No execution ID found for stream: ${id}`);
          return undefined;
        }
        if (!runConfig) {
          logger.warn(`No run config found for stream: ${id}`);
          return undefined;
        }
        const parentStreamId = progressState.snapshots.getParentStreamId(id);
        return {
          runState: runConfig,
          executionId,
          ...(parentStreamId !== undefined && { parentStreamId }),
        };
      },
      resumeToolUse: resumeExtensionToolUseFromResumeData,
      executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
        runExecuteCommand({
          config,
          executionId,
          modelHandlerCompatibilityKey,
        }),
      reportNoResumableSession: async (id) => {
        logger.warn(`No resumable session state for stream: ${id}`);
        await session.interactions.showInfoMessage(
          'This run cannot be resumed. Start a new run instead.',
          { replayWhenAttached: true },
        );
      },
      reportFailure: (id, error) => {
        logger.error(`Failed to resume stream: ${id}`, { data: error });
      },
    },
    claimedRecovery,
  ).finally(() => {
    session.followUps.release(claimedRecovery, 'recoverable');
  });
}
