/**
 * A GUI window of one session, as both GUI hosts build it: the session
 * bridge its surfaces subscribe to, its host snapshot, its tool-edit view,
 * its attachment as the project's window, its run actions, its file actions,
 * its transcript export, and the `host.request` body both hosts answer
 * through: one switch, one case order, one wire contract, over a binding
 * table each host fills with the verbs it actually performs. The policy (the
 * order, the guards, the refusal wording, the guide pages) lives here once,
 * and the difference between the hosts is the table.
 *
 * A host answers its own way only the kinds `OWN_REQUEST_LABEL` lists
 * ({@link OwnHostRequest}: its file pickers, its editor's current file, its
 * tab pop-out), so its switch stays exhaustive and the compiler still names
 * a kind it forgot.
 */
import * as path from 'node:path';

import { formatResultCount } from '@texra-ai/harness/transcript';

import { Effect, Exit, Layer, Scope, Stream, SubscriptionRef } from 'effect';

import {
  Cancelled,
  Rejected,
  Unavailable,
  type HostRequestFailure,
  type Session,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import {
  AgentDirectories,
  SessionHostInteractions,
  sessionFsLayer,
  workspaceEnvironmentLayer,
  type ProcessServices,
  type StorageFs,
  type WorkspaceFs,
} from '@texra-ai/harness/host';
import { ToolRegistry } from '@texra-ai/harness/plugins';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type {
  FileOpResult,
  HostRequest,
} from '@texra/shared/session/hostRequest';
import type { ProjectDisplay } from '@texra/shared/session/hostSnapshot';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import type { MessageHost } from '@texra/hosts/uiHosts';
import type { TexraPlugin } from '@texra/tools/registry';
import {
  ToolEditApprovalController,
  type ToolEditApprovalHost,
} from '@texra/controllers/approval/ToolEditApprovalController';
import { attachDroppedFiles } from '@texra/controllers/mainView/MainViewDroppedFilesController';
import {
  launchApprovalOptions,
  launchFormOf,
  prepareSurfaceLaunch,
} from '@texra/controllers/mainView/backend/MainViewRunLaunchController';
import {
  exportRunTranscript,
  type TranscriptExportHost,
} from '@texra/controllers/progressView/exportTranscript';
import { traceViewerTemplatePath } from '@texra/agent/export/standaloneTraceHtml';
import {
  ProgressWorkflowFileActionsController,
  type ProgressWorkflowFileActionsHost,
} from '@texra/controllers/progressView/ProgressWorkflowFileActionsController';
import {
  ApiKeyPromptFailed,
  ProgressApiKeyRetryController,
} from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import { linkOutage, type ServiceLink } from '@texra/controllers/server/client';
import {
  attachWindowHost,
  type WindowClient,
  type WindowHost,
} from '@texra/controllers/server/windowHost';
import { documentsOf } from '@texra/shared/plugins/documents';
import { texraGuideUrl } from '@ui/copy/guide';
import {
  latexdiffVerbs,
  type LatexdiffHost,
} from '@texra/latex/latexdiff/latexdiffVerbs';
import {
  createHostRunActions,
  type HostRunActionPorts,
} from './hostRunActions';
import {
  openHostSnapshotSource,
  type HostSnapshotSource,
} from './hostSnapshotSource';
import { SessionBridge } from './SessionBridge';
import { findLabelInWorkspace } from './workspaceFileOptions';
import type { RunId } from '@texra-ai/harness/schemas';
import type { ApiKeyProviderId } from '@texra-ai/llm';
import type { HostDraftRequests } from './hostDraftRequests';

/** A window's runs: its project's session, wherever its runs run (here,
 *  or in the background service), and the link the window attaches
 *  through (this process's windows, or the service's). */
export interface GuiSession {
  readonly session: Session;
  readonly link: ServiceLink<WindowClient>;
}

/** The kinds a host answers its own way, and what the refusal of one a
 *  host lacks names; the shared body answers every other kind. */
const OWN_REQUEST_LABEL = {
  popOut: 'Pop-out to editor',
  popBack: 'Pop-out to editor',
  useCurrentFile: "The editor's current file",
  addOpenedFiles: "The editor's open files",
  gettingStarted: 'Starting a project',
  workspaceFile: 'The file editor',
} as const satisfies Partial<Record<HostRequest['kind'], string>>;

/** The requests a host answers its own way. */
export type OwnHostRequest = Extract<
  HostRequest,
  { kind: keyof typeof OWN_REQUEST_LABEL }
>;

type SharedHostRequest = Exclude<HostRequest, OwnHostRequest>;

const isOwnHostRequest = (request: HostRequest): request is OwnHostRequest =>
  Object.hasOwn(OWN_REQUEST_LABEL, request.kind);

/** The arms a host answers its own way, by kind. A kind a host leaves
 *  out is refused by the shared router, worded once for both hosts. */
export type OwnHostArms = {
  readonly [K in OwnHostRequest['kind']]?: (
    request: Extract<OwnHostRequest, { kind: K }>,
    port: string,
  ) => HostVerb<HostOutcome>;
};

/** A verb a host binds: it runs on the fiber the window's dispatch owns, and
 *  its failure is the value the case answers with. */
type HostVerb<A> = Effect.Effect<
  A,
  HostRequestFailure,
  ProcessServices | StorageFs | WorkspaceFs
>;

type LatexdiffsRequest = Extract<HostRequest, { kind: 'latexdiffs' }>;

/**
 * The verbs behind the shared arms. Every member is a capability the host
 * performs; nothing here decides anything, which is the point: the decision
 * -- the order, the guard, the refusal wording -- is in the one body below.
 */
export interface SharedHostRequestBindings {
  /** Open a file of this session's workspace, at a line when one is named. */
  openPath(file: string, line: number | undefined): HostVerb<void>;
  /** The files the user picked for a launcher field; null when they picked
   *  none. */
  pickFiles(
    fileType: Extract<HostRequest, { kind: 'pickFiles' }>['fileType'],
  ): HostVerb<readonly string[] | null>;
  /** How a generated diff opens and a diff run shows its progress. */
  readonly latexdiff: LatexdiffHost;
  /** Settings at a target, or where it was last left without one. */
  openSettings(target: SettingsTarget | undefined): HostVerb<void>;
  /** Ask for a provider API key, `provider`'s when a retry names one: a
   *  prompt on one host, the Models tab on the other. The caller re-reads
   *  the secret store after this returns. */
  setApiKey(provider?: ApiKeyProviderId): HostVerb<void>;
  /** Open a web address in the browser. */
  openExternal(url: string): HostVerb<void>;
  readonly recheckDependencies: HostVerb<void>;
  readonly openInstallGuide: HostVerb<void>;
  /** The onboarding card's five verbs; its sixth, "set an API key", is
   *  {@link SharedHostRequestBindings.setApiKey}, the same verb the banner
   *  takes. */
  readonly onboarding: {
    readonly signInChatGpt: HostVerb<void>;
    readonly skip: HostVerb<void>;
    readonly runSetup: HostVerb<void>;
    readonly skipSetup: HostVerb<void>;
    readonly openGettingStarted: HostVerb<void>;
  };
}

/** The window's parts its host's verbs act on. */
interface GuiWindowParts {
  readonly bridge: SessionBridge;
  readonly snapshot: HostSnapshotSource;
}

/** What a host does for its window: the shared body's verbs, the requests
 *  it answers its own way, and the host verbs of the window's parts. */
interface GuiWindowHost extends Pick<
  MessageHost,
  'showInfoMessage' | 'showWarningMessage'
> {
  readonly bindings: SharedHostRequestBindings;
  readonly own: OwnHostArms;
  /** What the window does for its project's runs, here or in the service. */
  readonly window: WindowHost;
  readonly runs: Pick<HostRunActionPorts, 'openFinalOutput' | 'revealProgress'>;
  readonly files: Omit<ProgressWorkflowFileActionsHost, 'showInfo'>;
  /** The transcript export's format picker and opener, the LaTeX export's
   *  preamble, and the host's resources directory, which holds the
   *  standalone trace viewer's template. */
  readonly export: TranscriptExportHost & {
    readonly latexPreamble: string;
    readonly resourcesPath: string;
  };
}

interface GuiWindowPorts {
  readonly runs: GuiSession;
  readonly roots: WorkspaceRoots;
  readonly project: ProjectDisplay;
  /** The snapshot reads only this host answers. */
  readonly snapshot: Omit<
    Parameters<typeof openHostSnapshotSource>[0],
    'project' | 'tools' | 'root' | 'stores'
  >;
  readonly toolEdits: ToolEditApprovalHost;
  /** Emits when the window gains focus, so the project's calls come here
   *  first. */
  readonly focused: Stream.Stream<void>;
  /** The one process recorder. */
  readonly draftRequests: HostDraftRequests;
  /** The host's half of the window, over its parts. */
  host(
    parts: GuiWindowParts,
  ): Effect.Effect<GuiWindowHost, never, Scope.Scope | ProcessServices>;
}

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

/** What the window tells the user after a pack or clean (the latexdiff
 *  pack's counterpart is `latexdiffPackMessage`). */
function fileOpResultMessage(
  operation: 'pack' | 'clean',
  result: FileOpResult,
  inputFile: string,
): string {
  if (result.status === 'noFiles')
    return `No files found to ${operation} for ${inputFile}`;
  if (operation === 'clean') return `Cleanup complete for ${inputFile}`;
  return result.outputFolder
    ? `Files packed into ${result.outputFolder}`
    : 'Files packed.';
}

/**
 * Open a window of `ports.runs` for the caller's scope. The bridge has a
 * scope of its own, closed off the window's release: it drains the requests
 * in flight when it closes, and a launch request lives as long as its run,
 * so a window that closes neither waits for a run to end nor stops it. The
 * tool-edit previews close with the window, awaited, so their files are gone
 * before the window's release returns.
 */
export const openGuiWindow = Effect.fn('openGuiWindow')(function* (
  ports: GuiWindowPorts,
) {
  const { runs, roots } = ports;
  const { session } = runs;
  // The project's `.env` over the process's: what this window asks about its
  // project (model options, a polish's helper model) answers from it, as the
  // project's runs do.
  const env = workspaceEnvironmentLayer(roots.workspace);
  const bridgeScope = yield* Scope.make();
  yield* Effect.addFinalizer(() =>
    Effect.asVoid(Effect.forkDetach(Scope.close(bridgeScope, Exit.void))),
  );
  // cast: the table holds TeXRA's list as listed, each entry a `TexraPlugin`.
  const plugins = [
    ...(yield* ToolRegistry).entries.values(),
  ] as readonly TexraPlugin[];
  const snapshot = yield* openHostSnapshotSource({
    ...ports.snapshot,
    project: ports.project,
    tools: {
      icons: Object.fromEntries(
        plugins.flatMap((plugin) => Object.entries(plugin.icons ?? {})),
      ),
      terminalOutput: plugins.flatMap((plugin) => plugin.terminalOutput ?? []),
    },
    root: roots.workspace,
    stores: roots,
  });
  const draftRequests = yield* ports.draftRequests.attach(roots);
  yield* Effect.forkScoped(
    Stream.runForEach(
      SubscriptionRef.changes(ports.draftRequests.recording),
      snapshot.setRecording,
    ),
  );
  const bridge = yield* SessionBridge.make({
    session,
    host: snapshot.changes,
    handleHostRequest: handle,
    onPortClosed: draftRequests.closePort,
  }).pipe(Scope.provide(bridgeScope));
  const host = yield* ports.host({ bridge, snapshot });

  // The window is its project's window wherever its runs run: here,
  // through this process's own windows, or in the service, whose runs ask
  // it for the same. Its own failures before a run opens, it presents
  // itself.
  const workspace = roots.workspace ?? roots.storage;
  const present = new SessionHostInteractions(host.window);
  yield* Effect.forkScoped(
    attachWindowHost(runs.link, workspace, host.window, ports.focused),
  );
  // While the link holds no service, the banner says why (reaching it
  // again, or refused by a newer TeXRA), so the view never sits frozen
  // without saying so; a link to this process is never away.
  yield* Effect.forkScoped(
    Stream.runForEach(linkOutage(runs.link), (reason) =>
      snapshot.setServiceOffline(reason),
    ),
  );

  const toolEditApprovals = new ToolEditApprovalController({
    host: ports.toolEdits,
    session,
    roots,
  });
  yield* Effect.forkScoped(toolEditApprovals.follow);

  /** One program per request, over this session's rooted filesystems and
   *  its project's `.env`: the root a request writes under is chosen here,
   *  at the window's edge, once for the whole dispatch. */
  const requestLayer = Layer.merge(sessionFsLayer(roots), env);
  const runActions = yield* createHostRunActions({
    ...host.runs,
    // A run this window started is in the window's view before it is in a
    // surface's, whose frames are cut from the session after it: each
    // surface selects the run once its own view holds its activation. The
    // missing-agent warning the run's agent resolved goes at once.
    launched: (run) =>
      Effect.sync(() =>
        bridge.surfaceAction({
          kind: 'selectOnArrival',
          runId: run.runId,
          cursor: run.activation,
        }),
      ).pipe(Effect.andThen(snapshot.clearAgentConfigBanner)),
    roots,
    present,
    session,
    showInfo: host.showInfoMessage,
    showWarning: host.showWarningMessage,
  });
  const workflowFileActions = new ProgressWorkflowFileActionsController({
    outputFiles: (runId) => {
      const run = session.view.current().runs.get(runId);
      return run === undefined ? {} : documentsOf(run).files;
    },
    storageRoot: roots.storage,
    workspace: roots.workspace,
    host: { ...host.files, showInfo: host.showInfoMessage },
    runs: runActions,
  });

  const { bindings } = host;
  const apiKeyRetry = new ProgressApiKeyRetryController({
    // The set-key verb either runs or faults, so its failure is the one
    // failure, as `ApiKeyPromptFailed`.
    promptForApiKey: (provider) =>
      bindings.setApiKey(provider).pipe(
        Effect.provide(requestLayer),
        Effect.mapError(
          (failure) =>
            new ApiKeyPromptFailed({
              provider,
              message: 'The host could not ask for a provider API key.',
              cause: failure,
            }),
        ),
      ),
    session,
  });
  const latexdiff = latexdiffVerbs({
    host: bindings.latexdiff,
    roots,
    session,
    messages: host,
  });
  const exportTranscript = (runId: RunId) =>
    exportRunTranscript(runId, {
      pickFormat: host.export.pickFormat,
      openPath: host.export.openPath,
      showInfo: host.showInfoMessage,
      showWarning: host.showWarningMessage,
      roots,
      session,
      latexPreamble: host.export.latexPreamble,
      templatePath: traceViewerTemplatePath(host.export.resourcesPath),
    });
  /**
   * One program per shared request, as a host's own arms are: it runs on the
   * fiber the window's dispatch already owns and finishes nothing, so its
   * failure reaches the bridge's view as the value the port carried.
   */
  function shared(
    request: SharedHostRequest,
    port: string,
  ): HostVerb<HostOutcome> {
    /** The Tools sheet's verbs over the launcher's base and edited files. */
    const latexdiffs = Effect.fn('latexdiffs')(function* (
      sheet: LatexdiffsRequest,
    ) {
      const { action } = sheet;
      const baseFile = sheet.baseFile ?? '';
      const editedFile = sheet.editedFile ?? '';
      if (
        action === 'latexdiffvc' ||
        action === 'packLatexdiffvc' ||
        action === 'cleanLatexdiffvc'
      ) {
        yield* latexdiff.againstCommit(
          action,
          baseFile,
          sheet.commit ?? 'HEAD',
        );
        return;
      }
      if (!baseFile || !editedFile) {
        return yield* new Rejected({
          reason: 'Choose a base file and an edited file first.',
        });
      }
      switch (action) {
        case 'compare':
          yield* workflowFileActions.compareOriginal(editedFile, baseFile);
          return;
        case 'accept':
          yield* workflowFileActions.acceptFile(editedFile, baseFile);
          return;
        case 'merge':
          yield* workflowFileActions.mergeFile(editedFile, baseFile);
          return;
        case 'latexdiff':
          yield* latexdiff.file(baseFile, editedFile);
          return;
      }
    });

    return Effect.gen(function* () {
      switch (request.kind) {
        case 'pickFiles': {
          const paths = yield* bindings.pickFiles(request.fileType);
          if (paths === null) return yield* new Cancelled();
          return { kind: 'files', paths } satisfies HostOutcome;
        }
        case 'openFile':
          yield* bindings.openPath(request.path, request.line ?? undefined);
          return done;
        case 'openLabel': {
          // The search is the body's; the host only opens the match.
          const opened = yield* findLabelInWorkspace(
            roots.workspace,
            request.label,
            (absolutePath, line) => bindings.openPath(absolutePath, line),
          );
          if (!opened) {
            return yield* new Rejected({
              reason: `No file defines the label ${request.label}.`,
            });
          }
          return done;
        }
        case 'openRunStorage':
          yield* workflowFileActions.openRunStorage(request.runId);
          return done;
        case 'attachDroppedFiles': {
          const attached = yield* attachDroppedFiles(
            roots.workspace,
            request.paths,
            getIncludedExtensions(request.category),
          );
          if (attached.attachedCount > 0 && attached.rejectedCount > 0) {
            yield* Effect.forkDetach(
              host
                .showInfoMessage(
                  `Attached ${formatResultCount(attached.attachedCount, 'dropped file')}; skipped ${formatResultCount(attached.rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
                )
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning('Dropped-file notice failed', cause),
                  ),
                ),
            );
          }
          return { kind: 'files', paths: attached.paths };
        }
        case 'launch': {
          // A working directory must be the window's workspace or one of the
          // host's open workspace folders, as the composer lists them (the
          // desktop lists none: its window is its project).
          const asked = request.launch.workingDirectory.trim();
          const folders = [
            roots.workspace,
            ...ports.snapshot.workspaceRoots().map((folder) => folder.value),
          ];
          if (
            asked !== '' &&
            !folders.some(
              (folder) =>
                folder !== undefined &&
                path.resolve(folder) === path.resolve(asked),
            )
          )
            return yield* new Rejected({
              reason:
                'Choose one of the open workspace folders as the working directory.',
            });
          const config = yield* prepareSurfaceLaunch(request, roots);
          // The launcher has told, in this window, why a run did not start:
          // `Cancelled` is the answer the form shows nothing for, and it keeps
          // the instruction to send again.
          yield* runActions
            .runValidated(config, launchApprovalOptions(request))
            .pipe(Effect.mapError(() => new Cancelled()));
          return done;
        }
        case 'resume':
          yield* runActions.resume(request.runId);
          return done;
        case 'runAgain': {
          // The form opens on the run's setup; the person changes it and
          // starts it, so nothing launches here.
          const form = yield* launchFormOf(
            yield* runActions.runAgain(request.runId),
          );
          bridge.surfaceAction({ kind: 'selectNew' });
          bridge.surfaceAction({ kind: 'launch', patch: form });
          return done;
        }
        case 'fork': {
          const forked = yield* runActions.fork(
            request.runId,
            request.at ?? null,
          );
          const { draft } = request;
          if (draft != null) {
            // The composer keeps an image while its text holds the image's
            // `[name]` chip, the attached file's name. A send from the CLI
            // names it `[Image #N]` instead, so a missing chip is added.
            const images = (request.media ?? []).map((media) => ({
              fileName: media.name,
              media,
            }));
            const chips = images
              .map(({ fileName }) => `[${fileName}]`)
              .filter((chip) => !draft.includes(chip));
            bridge.surfaceAction({
              kind: 'draft',
              runId: forked,
              text: [draft, ...chips].join(' '),
              images,
            });
          }
          bridge.surfaceAction({ kind: 'select', runId: forked });
          return done;
        }
        case 'runCompileFixer':
          yield* runActions.runCompileFixer(request.runId);
          return done;
        case 'useOwnApiKey':
          yield* apiKeyRetry.useOwnApiKey(request);
          return done;
        case 'record':
        case 'polish':
        case 'savePastedImage':
          return yield* draftRequests.handle(request, port);
        case 'refreshCommits':
          yield* snapshot.refreshCommits;
          return done;
        case 'refreshFiles':
          yield* snapshot.refreshFiles;
          return done;
        case 'dismissBanner':
          yield* snapshot.dismissBanner(request.banner);
          return done;
        case 'toolEdit':
          yield* toolEditApprovals.handleAction(request);
          return done;
        case 'fileAction':
          yield* request.action === 'latexdiff'
            ? latexdiff.file(request.base ?? '', request.file)
            : workflowFileActions.handle({
                ...request,
                action: request.action,
              });
          return done;
        case 'exportTranscript':
          if (!session.view.current().runs.has(request.runId))
            return yield* new Unavailable({
              runId: request.runId,
              reason: 'The run is no longer open.',
            });
          yield* exportTranscript(request.runId);
          return done;
        case 'latexdiff':
          yield* runActions.workflowDiffRequest(request.runId);
          yield* latexdiff.run(request.runId);
          return done;
        case 'pack':
        case 'clean': {
          const files = yield* runActions.workflowFileOperation(
            request.runId,
            request.kind,
          );
          yield* host.showInfoMessage(
            fileOpResultMessage(request.kind, files.result, files.inputFile),
          );
          return done;
        }
        case 'latexdiffs':
          yield* latexdiffs(request);
          return done;
        case 'openSettings':
          yield* bindings.openSettings(request.target ?? undefined);
          return done;
        case 'apiKeyBanner':
          yield* request.action === 'set'
            ? bindings.setApiKey()
            : bindings.openExternal(
                texraGuideUrl('installation', 'setting-up-api-keys'),
              );
          return done;
        case 'agentConfigBanner':
          switch (request.action) {
            case 'edit':
              yield* bindings.openSettings('agents/library');
              return done;
            case 'dir': {
              // Without a custom directory there is nothing to reveal, so the
              // banner's link is the agent settings instead.
              if (request.customDirSet !== true) {
                yield* bindings.openSettings('agents/library');
                return done;
              }
              const directory = yield* (yield* AgentDirectories).custom();
              if (!directory)
                return yield* new Rejected({
                  reason: 'No custom agent directory is set.',
                });
              yield* host.files.openDirectory(directory);
              return done;
            }
            case 'docs':
              yield* bindings.openExternal(texraGuideUrl('custom-agents'));
              return done;
          }
          return done;
        case 'recheckDependencies':
          yield* bindings.recheckDependencies;
          return done;
        case 'openInstallGuide':
          yield* bindings.openInstallGuide;
          return done;
        case 'onboarding':
          switch (request.action) {
            case 'signInChatGpt':
              yield* bindings.onboarding.signInChatGpt;
              return done;
            case 'setApiKey':
              yield* bindings.setApiKey();
              return done;
            case 'skip':
              yield* bindings.onboarding.skip;
              return done;
            case 'runSetup':
              yield* bindings.onboarding.runSetup;
              return done;
            case 'skipSetup':
              yield* bindings.onboarding.skipSetup;
              return done;
            case 'openGettingStarted':
              yield* bindings.onboarding.openGettingStarted;
              return done;
          }
          return done;
      }
    });
  }
  /** An own kind the host binds runs its arm; one it leaves out is
   *  refused, worded here for both hosts. */
  const own = (
    request: OwnHostRequest,
    port: string,
  ): HostVerb<HostOutcome> => {
    const arm = host.own[request.kind];
    if (arm === undefined)
      return Effect.fail(
        new Rejected({
          reason: `${OWN_REQUEST_LABEL[request.kind]} is not available in this app.`,
        }),
      );
    // cast: the arm bound under `request.kind` takes a request of that kind.
    return (
      arm as (request: OwnHostRequest, port: string) => HostVerb<HostOutcome>
    )(request, port);
  };
  function handle(
    request: HostRequest,
    port: string,
  ): Effect.Effect<HostOutcome, HostRequestFailure, ProcessServices> {
    return Effect.provide(
      isOwnHostRequest(request) ? own(request, port) : shared(request, port),
      requestLayer,
    );
  }

  return { bridge, snapshot, present, runValidated: runActions.runValidated };
});
