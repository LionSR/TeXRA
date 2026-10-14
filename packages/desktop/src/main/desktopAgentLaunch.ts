import { Effect, type Scope } from 'effect';

import {
  Cancelled,
  type PlatformSecrets,
  type Run,
  type RunEndResult,
} from '@texra-ai/harness';
import { type ProcessRuntime, withProcessServices } from '@texra-ai/harness';
import { presentRunFailure, type RootLaunchRequest } from '@agent/runtime';
import type { RequestOpenFilePayload, RunId } from '@shared/schemas';
import type { RunValidatedOptions } from '@texra/controllers/session/hostRunActions';
import { selectAutoOpenFinalOutput } from '@texra/agent/output/selectAutoOpenFinalOutput';
import { ensureError } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import type { AgentConfig } from '@texra-ai/harness/schemas';
import type { DesktopAgentRun } from './desktopAgentRun.js';
import type { DesktopProject } from './desktopProjects.js';

/** What a launch and its output read of the project: where it runs, its
 *  roots, and where it presents. */
type LaunchProject = Pick<DesktopProject, 'session' | 'roots' | 'present'>;

interface DesktopAgentLaunchContext {
  readonly project: LaunchProject;
  /** The process runtime this host's launch runs on, handed down from the
   *  composition root rather than looked up. */
  readonly runtime: ProcessRuntime;
  /** The window's scope: what the launch does when its run ends lives as
   *  long as the window. */
  readonly scope: Scope.Scope;
}

export type DesktopAgentLaunchOptions = RunValidatedOptions & {
  /** The run is admitted: its id, for the window to select. */
  readonly onAdmitted?: (runId: RunId) => Effect.Effect<void, Error>;
};

/**
 * Start a desktop run, answering once it is admitted; its awaiting host
 * owns the presentation of a failure to start. Its final output opens when
 * it ends. The program takes the process services from the runtime's own
 * context on the fiber that runs it, as the resume port's program does, so
 * the effect itself requires nothing.
 */
export function launchDesktopAgent(
  request: RootLaunchRequest,
  context: DesktopAgentLaunchContext,
  { onAdmitted, ...options }: DesktopAgentLaunchOptions = {},
): Effect.Effect<Run, Error> {
  const launch = context.project.session
    .start({ ...request, ...options, interactive: true })
    .pipe(
      Effect.tap((run) => onAdmitted?.(run.runId) ?? Effect.void),
      // Presentation reacts to the outcome the run committed; it never runs
      // inside the run, so it cannot change that outcome.
      Effect.tap((run) =>
        Effect.forkIn(
          run.result.pipe(
            Effect.flatMap(
              presentDesktopFinalOutput(context.project, request.config),
            ),
            Effect.ignore({ log: 'Warn', message: 'Opening the output' }),
          ),
          context.scope,
        ),
      ),
    );
  return withProcessServices(context.runtime, launch);
}

/** Open a settled run's final output, as a fresh launch and a resume both do. */
export const presentDesktopFinalOutput =
  ({ roots, present }: Omit<LaunchProject, 'session'>, config: AgentConfig) =>
  (result: RunEndResult) =>
    Effect.gen(function* () {
      const output = yield* selectAutoOpenFinalOutput(roots, config, result);
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
      yield* present.emit(
        'requestOpenFile',
        { location, preserveFocus: false },
        { replayWhenAttached: true },
      );
    });

/**
 * Launch the setup conversation from the setup card: resolve a model the
 * user's credentials can call, build the setup execute request, and run it
 * through the same desktop execute path the renderer's Execute button uses.
 * `run` and `project` are the project the user started setup in, taken before
 * the first suspension: the run and its presentation belong to it even when
 * the window moves to another project while the model resolves and agents
 * load. Setup continues after its initiating request has completed, so a
 * failure is presented here and the kickoff settles.
 */
export const kickoffDesktopSetup = (options: {
  readonly project: Omit<LaunchProject, 'session'>;
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
        try: () => import('@texra/controllers/onboarding/setupLaunch'),
        catch: ensureError,
      });
      const request = yield* buildDesktopSetupRunRequest(
        options.project.roots,
        options.secrets,
      );
      if (!request) {
        return yield* Effect.fail(
          new Error(
            'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
          ),
        );
      }
      return yield* options.run.runValidated(request);
    }).pipe(
      Effect.catch((error) => {
        if (error instanceof Cancelled) return Effect.void;
        return presentRunFailure(options.project.present, error);
      }),
      // The kickoff settles with the setup run, so a second Run Setup
      // waits for it; the run's own failure is its result row's to show.
      Effect.flatMap((run) =>
        run === undefined
          ? Effect.void
          : run.result.pipe(
              Effect.asVoid,
              Effect.catch((failure) =>
                Effect.logDebug(`The setup run failed: ${failure.message}`),
              ),
            ),
      ),
    ),
  );
