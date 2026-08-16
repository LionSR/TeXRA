/** Persisted-state auto-resume entry point for the VS Code host. */
import * as vscode from 'vscode';

import { createChannelTrace } from '@agent/trace';
import {
  defaultSession,
  describeResumeFailure,
  resolveAndResumeStream,
  resolveResumeStateFromSnapshots,
  resumeQueuedToolUseFromResumeData,
  resumeStreamWithRecovery,
  trackTerminalResultPresentation,
} from '@agent/runtime';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';

import { runExecuteCommand } from './executeCommand';

const logger = createChannelTrace('resumeFromResumeData');

export function tryResumeFromResumeData(
  streamId: StreamTabId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const session = defaultSession();
  return resumeStreamWithRecovery(
    session,
    streamId,
    (claimedRecovery) => {
      const terminalResult = trackTerminalResultPresentation(
        session,
        (event) => event.streamId === streamId,
      );
      const reportResumeFailure = async (error: unknown): Promise<void> => {
        logger.error(`Failed to resume stream: ${streamId}`, { data: error });
        await terminalResult.reportUnhandled(() =>
          vscode.window.showWarningMessage(
            describeResumeFailure(error).message,
          ),
        );
      };
      return resolveAndResumeStream(
        streamId,
        {
          streamStatus: session.status,
          isCancellationRequested: () => !session.transcripts.has(streamId),
          resolveResumeState: (id) =>
            resolveResumeStateFromSnapshots(session.snapshots, id),
          reportResumeStateResolution: async (id, resolution, message) => {
            if (resolution.status === 'read-failed') {
              logger.warn(`Failed to read persisted resume data for ${id}`, {
                data: resolution.error,
              });
            } else {
              logger.warn(
                resolution.executionId === undefined
                  ? `No execution ID found for stream: ${id}`
                  : `No run config found for stream: ${id}`,
              );
            }
            await session.interactions.showInfoMessage(message, {
              replayWhenAttached: true,
            });
          },
          resumeToolUse: (resume, claimedRecovery) =>
            resumeQueuedToolUseFromResumeData(resume.streamId, resume, {
              recovery: claimedRecovery,
              onError: reportResumeFailure,
            }),
          executeWorkflow: (
            config,
            executionId,
            modelHandlerCompatibilityKey,
          ) =>
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
          reportFailure: (_id, error) => reportResumeFailure(error),
        },
        claimedRecovery,
      ).finally(terminalResult.dispose);
    },
    recovery,
  );
}
