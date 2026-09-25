/** Persisted-state resume entry point for the VS Code host. */
import * as vscode from 'vscode';

import { Cause, Effect } from 'effect';

import {
  trackTerminalResultPresentation,
  type SessionHandle,
} from '@agent/runtime';
import {
  resumeCancellationLatch,
  resumeRunWithRefusalNotice,
} from '@controllers/session/resumeRunPresentation';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessRuntime } from '@platform/processRuntime';
import {
  AgentResumeFailed,
  type RecoveryContinuation,
} from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runExecuteCommand } from './executeCommand';

const CHANNEL = 'resumeFromResumeData';

export function tryResumeFromResumeData(
  runId: RunId,
  runtime: ProcessRuntime,
  session: SessionHandle,
  recovery?: RecoveryContinuation,
): Effect.Effect<boolean, AgentResumeFailed> {
  const terminalResult = trackTerminalResultPresentation(
    session,
    (event) => event.runId === runId,
  );
  const isCancellationRequested = resumeCancellationLatch(session, runId);
  // The refusal callback is synchronous; it records the reason and the
  // program logs it once the attempt settles, whichever way it settles.
  let refusal: string | undefined;
  const attempt = resumeRunWithRefusalNotice(
    runId,
    {
      session,
      recovery,
      isCancellationRequested,
      executeWorkflow: (config, id, modelCompatibilityKey) =>
        runExecuteCommand(
          {
            config,
            runId: id,
            modelCompatibilityKey,
          },
          session,
        ),
    },
    (failure) => {
      refusal = `Run ${runId} was not resumed: ${failure}`;
    },
  ).pipe(
    Effect.onExit(() =>
      refusal === undefined
        ? Effect.void
        : Effect.logWarning(refusal).pipe(withLogChannel(CHANNEL)),
    ),
  );
  // The resume is composed, not awaited. Its program takes the services the
  // port's Effect may not require, so they come from this runtime's context on
  // the fiber that runs it. A run that refused to resume is the `false` the
  // port answers; only a fault of the attempt itself — a warning the window
  // would not show included — reaches the caller's failure channel, as the
  // rejected promise did.
  return Effect.flatMap(runtime.contextEffect, (context) =>
    Effect.provideContext(attempt, context),
  ).pipe(
    Effect.catchCause((cause) => {
      if (isCancellationRequested()) return Effect.succeed(false);
      const error = Cause.squash(cause);
      const message = `Resume failed: ${toErrorMessage(error)}`;
      return Effect.logError(`Failed to resume run: ${runId}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.andThen(
          Effect.tryPromise({
            try: async () => {
              await terminalResult.reportUnhandled(() =>
                vscode.window.showWarningMessage(message),
              );
            },
            catch: (reportCause) =>
              new AgentResumeFailed({ runId, message, cause: reportCause }),
          }),
        ),
        Effect.as(false),
      );
    }),
    Effect.ensuring(Effect.sync(() => terminalResult.dispose())),
  );
}
