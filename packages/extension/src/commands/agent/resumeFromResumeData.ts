/** Persisted-state resume entry point for the VS Code host. */
import * as vscode from 'vscode';

import {
  defaultSession,
  describeFollowUpFailure,
  lookupStreamExecutionId,
  resumeRun,
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
    const executionId = await lookupStreamExecutionId(streamId, session);
    const result = executionId
      ? await resumeRun(executionId, {
          recovery,
          isCancellationRequested,
          executeWorkflow: (config, id, modelHandlerCompatibilityKey) =>
            runExecuteCommand({
              config,
              executionId: id,
              modelHandlerCompatibilityKey,
            }),
        })
      : { failed: 'not_resumable' as const };
    if (result === 'started') return true;
    if (!isCancellationRequested()) {
      logger.warn(`Stream ${streamId} was not resumed: ${result.failed}`);
      await session.interactions.showInfoMessage(
        describeFollowUpFailure(result.failed),
        { replayWhenAttached: true },
      );
    }
    return false;
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
