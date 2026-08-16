/** Persisted-state auto-resume entry point for the VS Code host. */
import * as vscode from 'vscode';

import {
  defaultSession,
  describeResumeFailure,
  describeResumeStateResolution,
  resolveAndResumeStream,
  resolveResumeStateFromSnapshots,
  resumeQueuedToolUseFromResumeData,
  resumeStreamWithRecovery,
  trackTerminalResultPresentation,
} from '@agent/runtime';
import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';

import { runExecuteCommand } from './executeCommand';

const logger = createLog('resumeFromResumeData');

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
      // Per-attempt monotone cancellation latch: once an observed transcript
      // absence invalidates the attempt, re-creating the same stream id cannot
      // make it admissible again. `canAcquireResumeLease` rechecks the same
      // latch under the execution-lease lock.
      let cancellationRequested = false;
      const isCancellationRequested = (): boolean => {
        if (!cancellationRequested && !session.transcripts.has(streamId)) {
          cancellationRequested = true;
        }
        return cancellationRequested;
      };
      const canAcquireResumeLease = () => !isCancellationRequested();
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
          isCancellationRequested,
          resolveResumeState: (id) =>
            resolveResumeStateFromSnapshots(session.snapshots, id),
          reportResumeStateResolution: async (id, resolution) => {
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
            // Deliberate C3/V4a host parity: unresolved persisted state
            // (read-failed/incomplete) surfaces here even on the automatic
            // follow-up resume path, which was previously silent.
            await session.interactions.showInfoMessage(
              describeResumeStateResolution(resolution),
              { replayWhenAttached: true },
            );
          },
          resumeToolUse: (resume, claimedRecovery) =>
            resumeQueuedToolUseFromResumeData(resume.streamId, resume, {
              session,
              recovery: claimedRecovery,
              canAcquireResumeLease,
              isCancellationRequested,
              onError: reportResumeFailure,
            }),
          executeWorkflow: (
            config,
            executionId,
            modelHandlerCompatibilityKey,
          ) =>
            runExecuteCommand(
              {
                config,
                executionId,
                modelHandlerCompatibilityKey,
              },
              { canAcquireResumeLease },
            ),
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
