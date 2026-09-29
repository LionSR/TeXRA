import { Effect } from 'effect';

import {
  presentRunFailure,
  selectAutoOpenFinalOutput,
  type RunEndResult,
  type RunAgentOptions,
  type RunAgentRequest,
  type SessionHandle,
} from '@agent/runtime';
import { loadAgents } from '@agent/index';
import {
  type ProcessRuntime,
  withProcessServices,
} from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { RequestOpenFilePayload } from '@shared/schemas';
import { Cancelled } from '@shared/session/requestErrors';
import { ensureError } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import type { DesktopAgentRun } from './desktopAgentRun.js';

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

/**
 * Launch the setup conversation from the setup card: resolve a model the
 * user's credentials can call, build the setup execute request, and run it
 * through the same desktop execute path the renderer's Execute button uses.
 * `run` and `session` are the project the user started setup in, taken before
 * the first suspension: the run and its presentation belong to it even when
 * the window moves to another project while the model resolves and agents
 * load. Setup continues after its initiating request has completed, so a
 * failure is presented here and the kickoff settles.
 */
export const kickoffDesktopSetup = (options: {
  readonly session: SessionHandle;
  /** The project's launch path; none when no folder is open. */
  readonly run: Pick<DesktopAgentRun, 'runValidated'> | undefined;
  readonly secrets: PlatformSecrets;
  readonly runtime: ProcessRuntime;
}): Effect.Effect<void> =>
  withProcessServices(
    options.runtime,
    Effect.gen(function* () {
      if (!options.run) {
        return yield* Effect.fail(
          new Error('Open a folder before running setup.'),
        );
      }
      const { buildDesktopSetupRunRequest } = yield* Effect.tryPromise({
        try: () => import('@controllers/onboarding/setupLaunch'),
        catch: ensureError,
      });
      const request = yield* buildDesktopSetupRunRequest(
        options.session.roots,
        options.secrets,
      );
      if (!request) {
        return yield* Effect.fail(
          new Error(
            'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
          ),
        );
      }
      // Idempotent: joins the in-flight/initialized registry so a kickoff
      // racing the startup `loadAgents()` cannot hit "Could not find agent:
      // setup" (mirrors `setupAssistantCommand.launchSetupAssistant`).
      yield* loadAgents();
      yield* options.run.runValidated(request);
    }).pipe(
      Effect.catch((error) => {
        if (error instanceof Cancelled) return Effect.void;
        return presentRunFailure(options.session.interactions, error);
      }),
    ),
  );
