// The desktop's half of a project's window (`openGuiWindow`): every
// capability a surface asks its host for, mapped onto the window's dialogs,
// the preview host, the file pickers, and the project's launch path, plus
// the arms the desktop answers its own way. Each arm answers exactly once
// with an outcome or a request error; an arm the desktop does not perform is
// `Rejected` with its reason, never dropped.

import { Effect } from 'effect';
import { Cancelled, Rejected, type Run } from '@texra-ai/harness';
import {
  AgentDirectories,
  AppSignals,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  type HostPresentation,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  pathToLocationIn,
} from '@texra-ai/harness/host';
import {
  toErrorMessage,
  type AgentConfig,
  type RunEndResult,
} from '@texra-ai/harness/schemas';
import {
  latexdiffPackMessage,
  runPackLatexdiffvc,
} from '@housekeeping/packLatexdiffvc';
import { LaTeXdiffService } from '@latex/latexdiff';
import latexPreamble from '@resources/templates/chatExport.tex';
import { ExternalOpenFailed } from '@texra/hosts/uiHosts';

import { ApiKeyPromptFailed } from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import { hostFailure } from '@texra/controllers/session/hostCallFailure';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import type {
  OwnHostRequest,
  SharedHostRequestBindings,
} from '@texra/controllers/session/openGuiWindow';
import type { SessionBridge } from '@texra/controllers/session/SessionBridge';
import { findLabelInWorkspace } from '@texra/controllers/session/workspaceFileOptions';
import { selectAutoOpenFinalOutput } from '@texra/agent/output/selectAutoOpenFinalOutput';
import { texraGuideUrl } from '@ui/copy/guide';

import {
  DESKTOP_DOCS_URL,
  postDesktopSettingsView,
} from '../shared/desktopCommandSurface.js';
import { DesktopProgressFileActions } from './desktopProgressFileActions.js';
import type { ApiKeyProviderId } from '@texra-ai/llm';
import type { DesktopOnboardingIpc } from './desktopOnboardingIpc.js';
import type { PreviewUnavailable } from './desktopPreviewHost.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopProject } from './desktopProjects.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';
import type { createDesktopWorkspaceIpc } from './desktopWorkspaceIpc.js';

interface DesktopHostRequestsOptions {
  /** The project this window serves: its runs run in its session, here or
   *  in the service. */
  project: DesktopProject;
  /** The window's bridge and snapshot. */
  bridge: SessionBridge;
  snapshot: HostSnapshotSource;
  host: DesktopAgentRunHost;
  files: DesktopFileSelection;
  workspaceFile: ReturnType<typeof createDesktopWorkspaceIpc>['file'];
  /** Packaged app resources root (`…/resources`), for export templates. */
  resourcesPath: string;
  postToRenderer(message: unknown): boolean | void;
  onboarding: Pick<
    DesktopOnboardingIpc,
    'skipOnboarding' | 'skipSetup' | 'runSetup' | 'signInWithChatGpt'
  >;
  openExternalUrl(url: string): Effect.Effect<void, PreviewUnavailable>;
  /** Re-probe the LaTeX toolchain. */
  recheckTools(): Effect.Effect<void, never, ProcessServices>;
  /** The process runtime this window was handed; every request arm below runs
   *  on it. */
  runtime: ProcessRuntime;
}

const CHANNEL = 'DesktopHostRequests';

/** The desktop's half of a project's window, for the window's scope. */
export const createDesktopHostRequests = Effect.fn('createDesktopHostRequests')(
  function* (options: DesktopHostRequestsOptions) {
    const { project, host, runtime, bridge, snapshot } = options;
    const { roots } = project;
    const signals = yield* AppSignals;
    // A shared controller's notice IS the refusal the request answers with.
    const rejectRequestEffect = (
      reason: string,
    ): Effect.Effect<void, Rejected> => Effect.fail(new Rejected({ reason }));

    /**
     * Each arm answers with the program that presents its notice; the
     * session forks it, so nothing here settles a dialog on a fiber of its
     * own. Where the failure is reported depends on the arm: the two dialog
     * members report their own (a dialog rejects when its window is torn
     * down beneath it, and the host binds them through `awaitOrReport`), so
     * the programs they hand back cannot fail; `openPath` fails in its own
     * channel and the session's fork warn-logs it.
     */
    const presentationEventHandlers: PresentationEventHandlers<
      RuntimePresentationEventPayloads,
      HostPresentation
    > = {
      // The desktop shell keeps the conversation canvas permanently on
      // screen, so there is no separate progress surface to reveal.
      requestEnsureProgressView: () => undefined,
      requestShowError: ({ message, docsPage }) =>
        host.showErrorDialog(message, docsPage),
      // An instruction is actionable guidance, not a failure, so it uses
      // the info-style dialog with each action token as a real button.
      requestShowInstruction: (instruction) =>
        host.showInstructionDialog(instruction.message, instruction.actions),
      showAgentConfigBanner: ({ agentName }) =>
        withProcessServices(runtime, snapshot.showAgentConfigBanner(agentName)),
      // Desktop has no editor integration to preview through, so the
      // resolved path goes to the preview-with-fallback host directly.
      requestOpenFile: (data) => host.openPath(data.location.absolutePath),
    };

    const fileActions = new DesktopProgressFileActions(
      {
        ...host,
        // The refusal is the notice: the member fails with the `Rejected`
        // the request answers with, exactly as the rejecting promise did.
        showErrorMessage: rejectRequestEffect,
      },
      { session: project.session, runtime },
    );

    /**
     * The sheet's commit verbs, the dock's "latexdiff vs last commit" among
     * them: latexdiff-vc over the base file against a commit, and the pack
     * and clean housekeeping of what it produced. The diff opens in the PDF
     * tab through the build display, as a run's outputs do. The math markup
     * is left to `diffCommandExecutor`, which reads `LATEXDIFF_MATH_MARKUP`.
     */
    const latexdiffAgainstCommit = (
      action: 'latexdiffvc' | 'packLatexdiffvc' | 'cleanLatexdiffvc',
      baseFile: string,
      commit: string,
    ) =>
      Effect.gen(function* () {
        if (!baseFile) {
          return yield* Effect.fail(
            new Rejected({ reason: 'Choose a base file first.' }),
          );
        }
        const base = pathToLocationIn(roots.workspace, baseFile);
        if (action === 'latexdiffvc') {
          const result = yield* new LaTeXdiffService(CHANNEL, roots).runDiffVc(
            base,
            commit,
          );
          if (!result.success) {
            return yield* Effect.fail(new Rejected({ reason: result.message }));
          }
          yield* host
            .openBuildDisplay({
              kind: 'external',
              absolutePath: result.diffPath,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.fail(hostFailure('host.openBuildDisplay', cause)),
              ),
            );
          return;
        }
        const packed = yield* runPackLatexdiffvc(
          baseFile,
          commit,
          action === 'cleanLatexdiffvc',
        );
        const message = latexdiffPackMessage(packed);
        if (message) yield* host.showInfoMessage(message);
      });

    /** This window's half of the shared body's binding table: every verb
     *  mapped onto the window's dialogs, its preview host, its settings
     *  view, and the project's launch path. */
    const bindings: SharedHostRequestBindings = {
      openPath: (file, line) => host.openPath(file, line),
      openLabel: (label) =>
        findLabelInWorkspace(roots.workspace, label, (absolutePath) =>
          host.openPath(absolutePath),
        ).pipe(Effect.mapError((cause) => hostFailure('openLabel', cause))),
      // The window's project is its one workspace: any launch runs as asked.
      admitLaunch: () => Effect.void,
      runWorkflowDiff: (request) =>
        fileActions
          .diffStreamToolbarAction(request.runId)
          .pipe(
            Effect.mapError((cause) =>
              hostFailure('fileActions.diffStreamToolbarAction', cause),
            ),
          ),
      latexdiffAgainstCommit,
      openSettings: (target) =>
        Effect.sync(() =>
          postDesktopSettingsView(options.postToRenderer, target),
        ),
      // Only the "ask the user for a key" step is host-specific: on the
      // desktop that means opening the Models tab rather than a modal
      // prompt.
      setApiKey: Effect.sync(() =>
        postDesktopSettingsView(options.postToRenderer, 'models/keys'),
      ),
      openGuide: (page, anchor) =>
        options.openExternalUrl(texraGuideUrl(page, anchor)),
      openCustomAgentDirectory: Effect.gen(function* () {
        const directory = yield* AgentDirectories.use((directories) =>
          directories.custom(),
        );
        yield* host.openPath(directory);
      }),
      recheckDependencies: Effect.suspend(() => options.recheckTools()),
      openInstallGuide: () =>
        Effect.sync(() =>
          postDesktopSettingsView(options.postToRenderer, 'plugins'),
        ),
      onboarding: {
        signInChatGpt: Effect.suspend(() =>
          options.onboarding.signInWithChatGpt(),
        ),
        skip: Effect.suspend(() => options.onboarding.skipOnboarding()),
        runSetup: Effect.suspend(() => options.onboarding.runSetup()),
        skipSetup: Effect.suspend(() => options.onboarding.skipSetup()),
        // The desktop has no walkthrough of its own: the card's "Open
        // walkthrough" opens the desktop docs.
        openGettingStarted: Effect.suspend(() =>
          options.openExternalUrl(DESKTOP_DOCS_URL),
        ),
      },
    };

    const notOnDesktop = (what: string) =>
      new Rejected({ reason: `${what} is not available in the desktop app.` });

    /** The arms this window performs its own way. A capability's failure is
     *  named through `hostFailure`, so the failure channel is the value the
     *  arm failed with. */
    const own = (request: OwnHostRequest) =>
      Effect.gen(function* () {
        switch (request.kind) {
          case 'popOut':
          case 'popBack':
            return yield* Effect.fail(notOnDesktop('Pop-out to editor'));
          case 'pickFiles': {
            const { fileType } = request;
            if (fileType === 'base' || fileType === 'edited') {
              return yield* Effect.fail(
                notOnDesktop(`A picker for ${fileType} files`),
              );
            }
            const paths = yield* options.files
              .pickFiles(fileType)
              .pipe(
                Effect.mapError((cause) =>
                  hostFailure('files.pickFiles', cause),
                ),
              );
            if (paths === null) return yield* Effect.fail(new Cancelled());
            return { kind: 'files' as const, paths };
          }
          case 'useCurrentFile':
          case 'addOpenedFiles':
            return yield* Effect.fail(
              notOnDesktop("The editor's current file"),
            );
          case 'gettingStarted':
            return yield* Effect.fail(notOnDesktop('Starting a project'));
          case 'workspaceFile':
            return yield* options.workspaceFile(request.action);
        }
      });

    return {
      bindings,
      own,
      window: {
        emit: <K extends RuntimePresentationEvent>(
          event: K,
          payload: RuntimePresentationEventPayloads[K],
        ): HostPresentation => presentationEventHandlers[event](payload),
        // What a service task wrote, told here as a task here tells it: the
        // file tree follows it.
        filesWritten: (absolutePaths: readonly string[]) =>
          signals.emit('workspaceFilesWritten', {
            absolutePaths: [...absolutePaths],
          }),
      },
      showInfoMessage: host.showInfoMessage,
      showWarningMessage: host.showWarningMessage,
      runs: {
        // Select the run and retire the missing-agent warning its agent
        // resolved.
        launched: (run: Run) =>
          Effect.sync(() =>
            bridge.surfaceAction({ kind: 'select', runId: run.runId }),
          ).pipe(Effect.andThen(snapshot.clearAgentConfigBanner)),
        // Desktop has no editor integration to preview through, so the
        // output goes to the preview-with-fallback host directly.
        openFinalOutput: (config: AgentConfig, result: RunEndResult) =>
          withProcessServices(
            runtime,
            selectAutoOpenFinalOutput(roots, config, result),
          ).pipe(
            Effect.flatMap((output) =>
              output ? host.openPath(output.absolutePath) : Effect.void,
            ),
          ),
        // Only the "ask the user for a key" step is host-specific: on the
        // desktop that means opening the Models tab rather than a modal
        // prompt. The controller re-reads the secret store after this
        // returns.
        promptForApiKey: (provider: ApiKeyProviderId) =>
          Effect.gen(function* () {
            postDesktopSettingsView(options.postToRenderer, 'models/keys');
            yield* host.showInfoMessage(
              'Add a provider API key in Models, then use "Retry" on the request.',
            );
          }).pipe(
            Effect.catchTag(
              'NotificationFailed',
              (failure): Effect.Effect<void, ApiKeyPromptFailed> =>
                Effect.fail(
                  new ApiKeyPromptFailed({
                    provider,
                    message:
                      'The desktop could not show the API key instruction.',
                    cause: failure.cause,
                  }),
                ),
            ),
          ),
      },
      files: {
        compareFiles: (baseFile: string, editedFile: string) =>
          fileActions.compareFiles(baseFile, editedFile),
        acceptEditedFile: (baseFile: string, editedFile: string) =>
          fileActions.acceptEditedFile(baseFile, editedFile),
        latexdiffFile: (baseFile: string, editedFile: string) =>
          fileActions
            .runLatexdiffFile(baseFile, editedFile)
            .pipe(
              Effect.mapError((cause) =>
                hostFailure('fileActions.runLatexdiffFile', cause),
              ),
            ),
        openDirectory: (directory: string) => host.openPath(directory),
      },
      export: {
        pickFormat: host.pickTranscriptExportFormat(),
        // The preview host has already shown its own notice; the port's
        // tag carries that refusal and its wording out unchanged.
        openPath: (filePath: string) =>
          host.openPath(filePath).pipe(
            Effect.mapError(
              (cause) =>
                new ExternalOpenFailed({
                  kind: 'path',
                  target: filePath,
                  message: toErrorMessage(cause),
                  cause,
                }),
            ),
          ),
        latexPreamble,
        resourcesPath: options.resourcesPath,
      },
    };
  },
);
