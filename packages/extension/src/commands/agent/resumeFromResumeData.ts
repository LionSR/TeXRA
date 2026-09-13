/** Persisted-state resume entry point for the VS Code host. */
import * as vscode from 'vscode';

import {
  defaultSession,
  trackTerminalResultPresentation,
} from '@agent/runtime';
import {
  resumeCancellationLatch,
  resumeRunWithRefusalNotice,
} from '@controllers/session/resumeRunPresentation';
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
  const isCancellationRequested = resumeCancellationLatch(session, runId);
  try {
    return await effectRuntime().runPromise(
      resumeRunWithRefusalNotice(
        runId,
        {
          session,
          recovery,
          isCancellationRequested,
          executeWorkflow: (config, id, modelCompatibilityKey) =>
            runExecuteCommand({
              config,
              runId: id,
              modelCompatibilityKey,
            }),
        },
        (failure) => {
          logger.warn(`Run ${runId} was not resumed: ${failure}`);
        },
      ),
    );
  } catch (error) {
    if (isCancellationRequested()) return false;
    logger.error(`Failed to resume run: ${runId}`, { data: error });
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
