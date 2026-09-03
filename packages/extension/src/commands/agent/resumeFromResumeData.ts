/** Persisted-state resume entry point for the VS Code host. */
import * as vscode from 'vscode';

import {
  defaultSession,
  resumeStreamWithRefusalNotice,
  trackTerminalResultPresentation,
} from '@agent/runtime';
import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runExecuteCommand } from './executeCommand';

const logger = createLog('resumeFromResumeData');

export async function tryResumeFromResumeData(
  streamId: StreamTabId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const session = defaultSession();
  const terminalResult = trackTerminalResultPresentation(
    session,
    (event) => event.streamId === streamId,
  );
  // Per-attempt monotone cancellation latch: once an observed transcript
  // absence invalidates the attempt, re-creating the same stream id cannot
  // make it admissible again.
  let cancellationRequested = false;
  const isCancellationRequested = (): boolean => {
    if (!cancellationRequested && !session.transcripts.has(streamId)) {
      cancellationRequested = true;
    }
    return cancellationRequested;
  };
  try {
    return await resumeStreamWithRefusalNotice(
      streamId,
      {
        recovery,
        isCancellationRequested,
        executeWorkflow: (config, id, modelHandlerCompatibilityKey) =>
          runExecuteCommand({
            config,
            executionId: id,
            modelHandlerCompatibilityKey,
          }),
      },
      (failure) => {
        logger.warn(`Stream ${streamId} was not resumed: ${failure}`);
      },
    );
  } catch (error) {
    if (isCancellationRequested()) return false;
    logger.error(`Failed to resume stream: ${streamId}`, { data: error });
    await terminalResult.reportUnhandled(() =>
      vscode.window.showWarningMessage(
        `Resume failed: ${toErrorMessage(error)}`,
      ),
    );
    return false;
  } finally {
    terminalResult.dispose();
  }
}
