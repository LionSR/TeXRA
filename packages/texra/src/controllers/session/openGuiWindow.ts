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
 * A host answers its own way only the kinds left out of
 * `SHARED_HOST_REQUEST_KINDS` ({@link OwnHostRequest}: its file pickers, its
 * editor's current file, its tab pop-out), so its switch stays exhaustive
 * and the compiler still names a kind it forgot.
 */
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
  Secrets,
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
import { exportRunTranscript } from '@texra/controllers/progressView/exportTranscript';
import { traceViewerTemplatePath } from '@texra/agent/export/standaloneTraceHtml';
import { ProgressWorkflowFileActionsController } from '@texra/controllers/progressView/ProgressWorkflowFileActionsController';
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
import { loadModelOptions } from '@texra/model/setupCredentialAccess';
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

/** The kinds the shared body answers. */
const SHARED_HOST_REQUEST_KINDS = [
  'agentConfigBanner',
  'apiKeyBanner',
  'attachDroppedFiles',
  'clean',
  'dismissBanner',
  'exportTranscript',
  'fileAction',
  'fork',
  'launch',
  'latexdiff',
  'latexdiffs',
  'onboarding',
  'openFile',
  'openInstallGuide',
  'openLabel',
  'openRunStorage',
  'openSettings',
  'pack',
  'polish',
  'recheckDependencies',
  'record',
  'refreshCommits',
  'refreshFiles',
  'resume',
  'runCompileFixer',
  'runAgain',
  'savePastedImage',
  'toolEdit',
  'useOwnApiKey',
] as const satisfies readonly HostRequest['kind'][];

type SharedHostRequest = Extract<
  HostRequest,
  { kind: (typeof SHARED_HOST_REQUEST_KINDS)[number] }
>;

/** The requests a host answers its own way. */
export type OwnHostRequest = Exclude<HostRequest, SharedHostRequest>;

/** The arms a host answers its own way, by kind. A kind a host leaves
 *  out is refused by the shared router, worded once for both hosts. */
export type OwnHostArms = {
  readonly [K in OwnHostRequest['kind']]?: (
    request: Extract<OwnHostRequest, { kind: K }>,
    port: string,
  ) => HostVerb<HostOutcome>;
};

/** What the refusal of an own kind a host lacks names. */
const OWN_REQUEST_LABEL: Readonly<Record<OwnHostRequest['kind'], string>> = {
  popOut: 'Pop-out to editor',
  popBack: 'Pop-out to editor',
  pickFiles: 'The file picker',
  useCurrentFile: "The editor's current file",
  addOpenedFiles: "The editor's open files",
  gettingStarted: 'Starting a project',
  workspaceFile: 'The file editor',
};

const sharedHostRequestKinds: ReadonlySet<HostRequest['kind']> = new Set(
  SHARED_HOST_REQUEST_KINDS,
);

const isSharedHostRequest = (
  request: HostRequest,
): request is SharedHostRequest => sharedHostRequestKinds.has(request.kind);

/** A verb a host binds: it runs on the fiber the window's dispatch owns, and
 *  its failure is the value the case answers with. */
type HostVerb<A> = Effect.Effect<
  A,
  HostRequestFailure,
  ProcessServices | StorageFs | WorkspaceFs
>;

type LaunchRequest = Extract<HostRequest, { kind: 'launch' }>;
type LatexdiffsRequest = Extract<HostRequest, { kind: 'latexdiffs' }>;

/**
 * The verbs behind the shared arms. Every member is a capability the host
 * performs; nothing here decides anything, which is the point: the decision
 * -- the order, the guard, the refusal wording -- is in the one body below.
 */
export interface SharedHostRequestBindings {
  /** Open a file of this session's workspace, at a line when one is named. */
  openPath(file: string, line: number | undefined): HostVerb<void>;
  /** Reveal the first file defining `label`; `false` when none does. */
  openLabel(label: string): HostVerb<boolean>;
  /** Admit a launch this host cannot run as asked, with the refusal that
   *  says why; the extension names only open workspace folders as a working
   *  directory. */
  admitLaunch(form: LaunchRequest['launch']): HostVerb<void>;
  /** How a generated diff opens and a diff run shows its progress. */
  readonly latexdiff: LatexdiffHost;
  /** Settings at a target, or where it was last left without one. */
  openSettings(target: SettingsTarget | undefined): HostVerb<void>;
  /** Ask for a provider API key, `provider`'s when a retry names one: a
   *  prompt on one host, the Models tab on the other. The caller re-reads
   *  the secret store after this returns. */
  setApiKey(provider?: ApiKeyProviderId): HostVerb<void>;
  /** Open the guide's `page` in the browser, at its section `anchor` when
   *  one is named (`texraGuideUrl`). */
  openGuide(page: string, anchor?: string): HostVerb<void>;
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
  readonly files: Omit<
    ConstructorParameters<
      typeof ProgressWorkflowFileActionsController
    >[0]['host'],
    'showInfo'
  >;
  /** The transcript export's format picker and opener, the LaTeX export's
   *  preamble, and the host's resources directory, which holds the
   *  standalone trace viewer's template. */
  readonly export: Pick<
    Parameters<typeof exportRunTranscript>[1],
    'pickFormat' | 'openPath'
  > & {
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

/** What the window tells the user after a pack or clean, at which severity
 *  (the latexdiff pack's counterpart is `latexdiffPackMessage`). */
function fileOpResultMessage(
  operation: 'pack' | 'clean',
  result: FileOpResult,
  inputFile: string,
): { readonly level: 'info' | 'error'; readonly text: string } {
  const gerund = operation === 'pack' ? 'packing' : 'cleaning';
  switch (result.status) {
    case 'success':
      if (operation === 'clean')
        return { level: 'info', text: `Cleanup complete for ${inputFile}` };
      return {
        level: 'info',
        text: result.outputFolder
          ? `Files packed into ${result.outputFolder}`
          : 'Files packed.',
      };
    case 'noFiles':
      return {
        level: 'info',
        text: `No files found to ${operation} for ${inputFile}`,
      };
    case 'missingParams':
      return { level: 'error', text: `Select an input file before ${gerund}.` };
    case 'error':
      return {
        level: 'error',
        text: `Error during ${gerund}: ${result.error}`,
      };
  }
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
  const scope = yield* Scope.Scope;
  const secrets = yield* Secrets;
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
    readConfig: (runId: RunId) => session.records(runId).readConfig(),
    present,
    session,
    scope,
    loadModelOptions: () =>
      loadModelOptions(roots).pipe(
        Effect.provide(env),
        Effect.provideService(Secrets, secrets),
      ),
    showInfo: host.showInfoMessage,
    showWarning: host.showWarningMessage,
  });
  const workflowFileActions = new ProgressWorkflowFileActionsController({
    state: runActions.runOutputs,
    storageRoot: roots.storage,
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
  const shared = (request: SharedHostRequest, port: string) =>
    answerShared(request, port, {
      bridge,
      snapshot,
      runActions,
      apiKeyRetry,
      workflowFileActions,
      draftRequests,
      toolEditApprovals,
      session,
      roots,
      bindings,
      latexdiff,
      showInfo: host.showInfoMessage,
      openDirectory: host.files.openDirectory,
      exportTranscript: (runId) =>
        exportRunTranscript(runId, {
          pickFormat: host.export.pickFormat,
          openPath: host.export.openPath,
          showInfo: host.showInfoMessage,
          showWarning: host.showWarningMessage,
          roots,
          session,
          latexPreamble: host.export.latexPreamble,
          templatePath: traceViewerTemplatePath(host.export.resourcesPath),
        }),
    });
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
      isSharedHostRequest(request) ? shared(request, port) : own(request, port),
      requestLayer,
    );
  }

  return { bridge, snapshot, present, runValidated: runActions.runValidated };
});

/** What the shared arms act on. */
interface SharedParts extends GuiWindowParts {
  readonly runActions: Effect.Success<ReturnType<typeof createHostRunActions>>;
  readonly apiKeyRetry: ProgressApiKeyRetryController;
  readonly workflowFileActions: ProgressWorkflowFileActionsController;
  readonly draftRequests: Effect.Success<
    ReturnType<HostDraftRequests['attach']>
  >;
  readonly toolEditApprovals: ToolEditApprovalController;
  readonly session: Session;
  readonly roots: WorkspaceRoots;
  readonly bindings: SharedHostRequestBindings;
  readonly latexdiff: ReturnType<typeof latexdiffVerbs>;
  readonly showInfo: MessageHost['showInfoMessage'];
  /** Reveal a directory in the host's file manager. */
  readonly openDirectory: GuiWindowHost['files']['openDirectory'];
  exportTranscript(runId: RunId): HostVerb<void>;
}

/**
 * One program per shared request, as a host's own arms are: it runs on the
 * fiber the window's dispatch already owns and finishes nothing, so its
 * failure reaches the bridge's view as the value the port carried.
 */
function answerShared(
  request: SharedHostRequest,
  port: string,
  parts: SharedParts,
): HostVerb<HostOutcome> {
  const { bindings: host, bridge } = parts;

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
      yield* parts.latexdiff.againstCommit(
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
        yield* parts.workflowFileActions.compareOriginal(editedFile, baseFile);
        return;
      case 'accept':
        yield* parts.workflowFileActions.acceptFile(editedFile, baseFile);
        return;
      case 'merge':
        yield* parts.workflowFileActions.mergeFile(editedFile, baseFile);
        return;
      case 'latexdiff':
        yield* parts.latexdiff.file(baseFile, editedFile);
        return;
    }
  });

  return Effect.gen(function* () {
    switch (request.kind) {
      case 'openFile':
        yield* host.openPath(request.path, request.line ?? undefined);
        return done;
      case 'openLabel': {
        // The "not found" message belongs to the request, not to either
        // host's search: both word it the same way.
        const opened = yield* host.openLabel(request.label);
        if (!opened) {
          return yield* new Rejected({
            reason: `No file defines the label ${request.label}.`,
          });
        }
        return done;
      }
      case 'openRunStorage':
        yield* parts.workflowFileActions.openRunStorage(request.runId);
        return done;
      case 'attachDroppedFiles': {
        const attached = yield* attachDroppedFiles(
          parts.roots.workspace,
          request.paths,
          getIncludedExtensions(request.category),
        );
        if (attached.attachedCount > 0 && attached.rejectedCount > 0) {
          yield* Effect.forkDetach(
            parts
              .showInfo(
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
        yield* host.admitLaunch(request.launch);
        const config = yield* prepareSurfaceLaunch(request, parts.roots);
        // The launcher has told, in this window, why a run did not start:
        // `Cancelled` is the answer the form shows nothing for, and it keeps
        // the instruction to send again.
        yield* parts.runActions
          .runValidated(config, launchApprovalOptions(request))
          .pipe(Effect.mapError(() => new Cancelled()));
        return done;
      }
      case 'resume':
        yield* parts.runActions.resume(request.runId);
        return done;
      case 'runAgain': {
        // The form opens on the run's setup; the person changes it and
        // starts it, so nothing launches here.
        const form = yield* launchFormOf(
          yield* parts.runActions.runAgain(request.runId),
        );
        bridge.surfaceAction({ kind: 'selectNew' });
        bridge.surfaceAction({ kind: 'launch', patch: form });
        return done;
      }
      case 'fork': {
        const forked = yield* parts.runActions.fork(
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
        yield* parts.runActions.runCompileFixer(request.runId);
        return done;
      case 'useOwnApiKey':
        yield* parts.apiKeyRetry.useOwnApiKey(request);
        return done;
      case 'record':
      case 'polish':
      case 'savePastedImage':
        return yield* parts.draftRequests.handle(request, port);
      case 'refreshCommits':
        yield* parts.snapshot.refreshCommits;
        return done;
      case 'refreshFiles':
        yield* parts.snapshot.refreshFiles;
        return done;
      case 'dismissBanner':
        yield* parts.snapshot.dismissBanner(request.banner);
        return done;
      case 'toolEdit':
        yield* parts.toolEditApprovals.handleAction(request);
        return done;
      case 'fileAction':
        yield* request.action === 'latexdiff'
          ? parts.latexdiff.file(request.base ?? '', request.file)
          : parts.workflowFileActions.handle({
              ...request,
              action: request.action,
            });
        return done;
      case 'exportTranscript':
        if (!parts.session.view.current().runs.has(request.runId))
          return yield* new Unavailable({
            runId: request.runId,
            reason: 'The run is no longer open.',
          });
        yield* parts.exportTranscript(request.runId);
        return done;
      case 'latexdiff':
        yield* parts.runActions.workflowDiffRequest(request.runId);
        yield* parts.latexdiff.run(request.runId);
        return done;
      case 'pack':
      case 'clean': {
        const files = yield* parts.runActions.workflowFileOperation(
          request.runId,
          request.kind,
        );
        // An info result is shown; an error result rejects the request,
        // which the surface presents.
        const message = fileOpResultMessage(
          request.kind,
          files.result,
          files.inputFile,
        );
        if (message.level === 'error')
          return yield* new Rejected({ reason: message.text });
        yield* parts.showInfo(message.text);
        return done;
      }
      case 'latexdiffs':
        yield* latexdiffs(request);
        return done;
      case 'openSettings':
        yield* host.openSettings(request.target ?? undefined);
        return done;
      case 'apiKeyBanner':
        yield* request.action === 'set'
          ? host.setApiKey()
          : host.openGuide('installation', 'setting-up-api-keys');
        return done;
      case 'agentConfigBanner':
        switch (request.action) {
          case 'edit':
            yield* host.openSettings('agents/library');
            return done;
          case 'dir': {
            // Without a custom directory there is nothing to reveal, so the
            // banner's link is the agent settings instead.
            if (request.customDirSet !== true) {
              yield* host.openSettings('agents/library');
              return done;
            }
            const directory = yield* (yield* AgentDirectories).custom();
            if (!directory)
              return yield* new Rejected({
                reason: 'No custom agent directory is set.',
              });
            yield* parts.openDirectory(directory);
            return done;
          }
          case 'docs':
            yield* host.openGuide('custom-agents');
            return done;
        }
        return done;
      case 'recheckDependencies':
        yield* host.recheckDependencies;
        return done;
      case 'openInstallGuide':
        yield* host.openInstallGuide;
        return done;
      case 'onboarding':
        switch (request.action) {
          case 'signInChatGpt':
            yield* host.onboarding.signInChatGpt;
            return done;
          case 'setApiKey':
            yield* host.setApiKey();
            return done;
          case 'skip':
            yield* host.onboarding.skip;
            return done;
          case 'runSetup':
            yield* host.onboarding.runSetup;
            return done;
          case 'skipSetup':
            yield* host.onboarding.skipSetup;
            return done;
          case 'openGettingStarted':
            yield* host.onboarding.openGettingStarted;
            return done;
        }
        return done;
    }
  });
}
