import { Effect } from 'effect';

import {
  selectAutoOpenFinalOutput,
  type RunEndResult,
  type RunAgentOptions,
  type RunAgentRequest,
  type SessionHandle,
} from '@agent/runtime';
import {
  type ProcessRuntime,
  withProcessServices,
} from '@platform/processRuntime';
import type { RequestOpenFilePayload } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';

interface DesktopAgentLaunchContext {
  readonly session: SessionHandle;
  /** The process runtime this host's launch runs on, handed down from the
   *  composition root rather than looked up. */
  readonly runtime: ProcessRuntime;
}

export type DesktopAgentLaunchOptions = Pick<
  RunAgentOptions,
  'ownApiKeyFallback' | 'preferHelperModel' | 'onRun' | 'onRunResolved'
>;

/**
 * Start a desktop run; its awaiting host owns failure presentation. The
 * returned Effect settles with the run itself. Its program takes the process
 * services from the runtime's own context on the fiber that runs it, as the
 * resume port's program does, so the effect itself requires nothing.
 */
export function launchDesktopAgent(
  request: RunAgentRequest,
  context: DesktopAgentLaunchContext,
  options: DesktopAgentLaunchOptions = {},
): Effect.Effect<void, Error> {
  const launch = Effect.gen(function* () {
    const { runAgent } = yield* Effect.tryPromise({
      try: () => import('@agent/runtime'),
      catch: ensureError,
    });
    yield* runAgent(request, {
      session: context.session,
      ownApiKeyFallback: options.ownApiKeyFallback,
      ...(options.preferHelperModel && { preferHelperModel: true }),
      onRun: options.onRun,
      onRunResolved: options.onRunResolved,
      suppressErrorNotification: true,
    }).pipe(
      // Presentation reacts to the outcome the run committed; it never runs
      // inside the run, so it cannot change that outcome.
      Effect.flatMap(presentDesktopFinalOutput(context.session)),
    );
  });
  return withProcessServices(context.runtime, launch);
}

/** Open a settled run's final output, as a fresh launch and a resume both do. */
export const presentDesktopFinalOutput =
  (session: SessionHandle) => (result: RunEndResult) =>
    Effect.gen(function* () {
      const output = yield* selectAutoOpenFinalOutput(session.roots, result);
      if (!output) return;
      let location: RequestOpenFilePayload['location'];
      if (output.location === 'workspace') {
        location = createWorkspaceLocation(
          output.absolutePath,
          output.relativePath,
        );
      } else if (output.location === 'runStorage') {
        location = createRunStorageLocation(
          output.absolutePath,
          output.relativePath,
          result.runId,
        );
      } else {
        location = createExternalLocation(output.absolutePath);
      }
      yield* session.interactions.emit(
        'requestOpenFile',
        { location, preserveFocus: false },
        { replayWhenAttached: true },
      );
    });
