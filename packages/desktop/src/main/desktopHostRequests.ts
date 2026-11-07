// The desktop's half of a project's window (`openGuiWindow`): every
// capability a surface asks its host for, mapped onto the window's dialogs,
// the preview host, the file pickers, and the project's launch path, plus
// the arms the desktop answers its own way. Each arm answers exactly once
// with an outcome or a request error; an arm the desktop does not perform is
// `Rejected` with its reason, never dropped.

import path from 'node:path';

import { Effect, Schema } from 'effect';
import { Cancelled } from '@texra-ai/harness';
import {
  AppSignals,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  type HostPresentation,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
} from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import latexPreamble from '@resources/templates/chatExport.tex';
import { ExternalOpenFailed } from '@texra/hosts/uiHosts';

import { hostFailure } from '@texra/controllers/session/hostCallFailure';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import type {
  OwnHostArms,
  SharedHostRequestBindings,
} from '@texra/controllers/session/openGuiWindow';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import { findLabelInWorkspace } from '@texra/controllers/session/workspaceFileOptions';
import { instructionActions } from '@ui/copy/instructionActions';
import { modelFailureText } from '@ui/copy/modelAccess';

import {
  DESKTOP_DOCS_URL,
  postDesktopSettingsView,
} from '../shared/desktopCommandSurface.js';
import type { WindowOnboarding } from './desktopWindowOnboarding.js';
import type { PreviewUnavailable } from './desktopPreviewHost.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopProject } from './desktopProjects.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';
import type { createDesktopWorkspaceIpc } from './desktopWorkspaceIpc.js';

interface DesktopHostRequestsOptions {
  /** The project this window serves: its runs run in its session, here or
   *  in the service. */
  project: DesktopProject;
  /** The window's host snapshot. */
  snapshot: HostSnapshotSource;
  host: DesktopAgentRunHost;
  files: DesktopFileSelection;
  workspaceFile: ReturnType<typeof createDesktopWorkspaceIpc>['file'];
  /** Packaged app resources root (`…/resources`), for export templates. */
  resourcesPath: string;
  postToRenderer(message: unknown): void;
  onboarding: Pick<
    WindowOnboarding,
    'skipOnboarding' | 'skipSetup' | 'runSetup' | 'signInWithChatGpt'
  >;
  openExternalUrl(url: string): Effect.Effect<void, PreviewUnavailable>;
  /** Re-probe the LaTeX toolchain. */
  recheckTools(): Effect.Effect<void, never, ProcessServices>;
  /** The process runtime this window was handed; every request arm below runs
   *  on it. */
  runtime: ProcessRuntime;
}

/**
 * The diff window would not open. The desktop's diff surface fails with what
 * it hit (a side that would not read, a patch the OS editor refused), and the
 * file-actions port takes tags, never a bare value, so the compare action
 * words that failure as this one.
 */
class DiffViewUnavailable extends Schema.TaggedError<DiffViewUnavailable>()(
  'DiffViewUnavailable',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The desktop's half of a project's window, for the window's scope. */
export const createDesktopHostRequests = Effect.fn('createDesktopHostRequests')(
  function* (options: DesktopHostRequestsOptions) {
    const { project, host, runtime, snapshot } = options;
    const { roots } = project;
    const signals = yield* AppSignals;
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
      requestShowError: (failure) =>
        host.showErrorDialog(modelFailureText(failure), failure.docsPage),
      // An instruction is actionable guidance, not a failure, so it uses
      // the info-style dialog with each action token as a real button.
      requestShowInstruction: (instruction) =>
        host.showInstructionDialog(
          instruction.message,
          instructionActions(instruction.key),
        ),
      agentNotFound: ({ agentName }) =>
        withProcessServices(runtime, snapshot.showAgentConfigBanner(agentName)),
      // Desktop has no editor integration to preview through, so the
      // resolved path goes to the preview-with-fallback host directly.
      openFile: (data) => host.openPath(data.location.absolutePath),
    };

    /** This window's half of the shared body's binding table: every verb
     *  mapped onto the window's dialogs, its preview host, its settings
     *  view, and the project's launch path. */
    const bindings: SharedHostRequestBindings = {
      openPath: (file, line) => host.openPath(file, line),
      openLabel: (label) =>
        findLabelInWorkspace(roots.workspace, label, (absolutePath) =>
          host.openPath(absolutePath),
        ).pipe(Effect.mapError((cause) => hostFailure('openLabel', cause))),
      latexdiff: {
        // Each diff opens in the PDF tab through the build display, as a
        // run's outputs do.
        openDiffs: (diffPaths) =>
          Effect.forEach(
            diffPaths,
            (absolutePath) =>
              host.openBuildDisplay({ kind: 'external', absolutePath }),
            { discard: true },
          ).pipe(
            Effect.mapError((cause) =>
              hostFailure('host.openBuildDisplay', cause),
            ),
          ),
        // The window has no progress chrome for a diff run.
        withProgress: (_title, task) => task({ report: () => undefined }),
      },
      openSettings: (target) =>
        Effect.sync(() =>
          postDesktopSettingsView(options.postToRenderer, target),
        ),
      // Only the "ask the user for a key" step is host-specific: on the
      // desktop that means opening the Models tab rather than a modal
      // prompt.
      setApiKey: () =>
        Effect.sync(() =>
          postDesktopSettingsView(options.postToRenderer, 'models/keys'),
        ),
      openExternal: (url) => options.openExternalUrl(url),
      recheckDependencies: Effect.suspend(() => options.recheckTools()),
      openInstallGuide: Effect.sync(() =>
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

    /** The arms this window performs its own way. A capability's failure is
     *  named through `hostFailure`, so the failure channel is the value the
     *  arm failed with. */
    const own: OwnHostArms = {
      pickFiles: (request) =>
        options.files.pickFiles(request.fileType).pipe(
          Effect.mapError((cause) => hostFailure('files.pickFiles', cause)),
          Effect.flatMap((paths) =>
            paths === null
              ? Effect.fail(new Cancelled())
              : Effect.succeed<HostOutcome>({ kind: 'files', paths }),
          ),
        ),
      workspaceFile: (request) => options.workspaceFile(request.action),
    };

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
        // Desktop has no editor integration to preview through, so the
        // output goes to the preview-with-fallback host directly.
        openFinalOutput: (absolutePath: string) => host.openPath(absolutePath),
        // The progress surface is always on screen in the desktop window.
        revealProgress: () => Effect.void,
      },
      files: {
        compareFiles: (baseFile: string, editedFile: string) =>
          host
            .openDiff(
              { filePath: baseFile },
              { filePath: editedFile },
              `Compare: ${path.basename(editedFile)} <-> ${path.basename(baseFile)}`,
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DiffViewUnavailable({
                    message: toErrorMessage(cause),
                    cause,
                  }),
              ),
            ),
        confirmAccept: (message: string) => host.confirmAcceptFile(message),
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
