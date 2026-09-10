/** Persisted-state resume entry point for the VS Code host. */
import * as vscode from 'vscode';

import {
  defaultSession,
  trackTerminalResultPresentation,
} from '@agent/runtime';
import { resumeRunWithRefusalNotice } from '@controllers/session/resumeRunPresentation';
import { createLog } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runExecuteCommand } from './executeCommand';

const logger = createLog('resumeFromResumeData');

export async function tryResumeFromResumeData(
  runId: RunId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const session = defaultSession();
  const terminalResult = trackTerminalResultPresentation(
    session,
    (event) => event.runId === runId,
  );
  // Per-attempt monotone cancellation latch: once an observed transcript
  // absence invalidates the attempt, re-creating the same stream id cannot
  // make it admissible again.
  let cancellationRequested = false;
  const isCancellationRequested = (): boolean => {
    if (!cancellationRequested && !session.transcripts.has(runId)) {
      cancellationRequested = true;
    }
    return cancellationRequested;
  };
  try {
    return await effectRuntime().runPromise(
      resumeRunWithRefusalNotice(
        runId,
        {
          session,
          recovery,
          isCancellationRequested,
          executeWorkflow: (config, id, modelHandlerCompatibilityKey) =>
            runExecuteCommand({
              config,
              runId: id,
              modelHandlerCompatibilityKey,
            }),
        },
        (failure) => {
          logger.warn(`Stream ${runId} was not resumed: ${failure}`);
        },
      ),
    );
  } catch (error) {
    if (isCancellationRequested()) return false;
    logger.error(`Failed to resume stream: ${runId}`, { data: error });
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
