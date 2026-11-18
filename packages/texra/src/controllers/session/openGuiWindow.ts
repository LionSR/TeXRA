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
 * ({@link OwnHostCommand}: its file pickers, its editor's current file, its
 * tab pop-out), so its switch stays exhaustive and the compiler still names
 * a kind it forgot.
 */
import * as path from 'node:path';

import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { type Session, type WorkspaceRoots } from '@texra-ai/harness';
import {
  AgentCatalog,
  AgentDirectories,
  presenterOn,
  sessionFsLayer,
  workspaceEnvironmentLayer,
  type HostPresentation,
  type PresentationEventHandlers,
  type ProcessServices,
  type RuntimePresentationEventPayloads,
} from '@texra-ai/harness/host';
import {
  AppSignals,
  ToolRegistry,
  type StorageFs,
  type WorkspaceFs,
} from '@texra-ai/harness/plugins';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { ProjectDisplay } from '@texra/shared/session/hostSnapshot';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import type { Dialogs } from '@texra/hosts/uiHosts';
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
import {
  ProgressDocumentTaskFileActionsController,
  type ProgressDocumentTaskFileActionsHost,
} from '@texra/controllers/progressView/ProgressDocumentTaskFileActionsController';
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
import { documentRoundsOf } from '@texra/shared/plugins/documents';
import { texraGuideUrl } from '@ui/copy/guide';
import { latexdiffVerbs, type LatexdiffHost } from './latexdiffVerbs';
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
import {
  agentKeyOf,
  formatResultCount,
  Cancelled,
  Rejected,
  Unavailable,
} from '@texra-ai/harness/schemas';
import type { ApiKeyProviderId } from '@texra-ai/llm';
import type { HostDraftRequests } from './hostDraftRequests';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import { openWindowSetup } from '@texra/controllers/onboarding/setupLaunch';
import type { SettingsHostBindings } from '@texra/controllers/settingsView/settingsHostBindings';
import { type HostCommandFailure } from '@texra/controllers/session/hostCallFailure';

/** A window's runs: its project's session, wherever its runs run (here,
 *  or in the background service), and the link the window attaches
 *  through (this process's windows, or the service's). */
export interface GuiSession {
  readonly session: Session;
  readonly link: ServiceLink<WindowClient>;
  /** Where the runs run, decided once at open: in the service, or in this
   *  process with why when the window has a folder the service would hold
   *  (it was out of reach); null for a window with no folder, which the
   *  service never holds. */
  readonly where: 'service' | { readonly local: string | null };
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
} as const satisfies Partial<Record<HostCommand['kind'], string>>;

/** The requests a host answers its own way. */
type OwnHostCommand = Extract<
  HostCommand,
  { kind: keyof typeof OWN_REQUEST_LABEL }
>;

type SharedHostCommand = Exclude<HostCommand, OwnHostCommand>;

const isOwnHostCommand = (request: HostCommand): request is OwnHostCommand =>
  Object.hasOwn(OWN_REQUEST_LABEL, request.kind);

/** The handlers a host answers its own way, by kind. A kind a host leaves
 *  out is refused by the shared router, worded once for both hosts. */
export type OwnHostHandlers = {
  readonly [K in OwnHostCommand['kind']]?: (
    request: Extract<OwnHostCommand, { kind: K }>,
    port: string,
  ) => HostVerb<HostOutcome>;
};

/** A verb a host binds: it runs on the fiber the window's dispatch owns, and
 *  its failure is the value the case answers with. */
type HostVerb<A> = Effect.Effect<
  A,
  HostCommandFailure,
  ProcessServices | StorageFs | WorkspaceFs
>;

/**
 * The verbs behind the shared handlers. Every member is a capability the host
 * performs; nothing here decides anything, which is the point: the decision
 * -- the order, the guard, the refusal wording -- is in the one body below.
 */
export interface SharedHostCommandBindings {
  /** Open a file of this session's workspace, at a line when one is named. */
  openPath(file: string, line: number | undefined): HostVerb<void>;
  /** The files the user picked for a launcher field; null when they picked
   *  none. */
  pickFiles(
    fileType: Extract<HostCommand, { kind: 'pickFiles' }>['fileType'],
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
  readonly openInstallGuide: HostVerb<void>;
  /** The onboarding card's verbs a host performs. "Set an API key" is
   *  {@link SharedHostCommandBindings.setApiKey}, the same verb the banner
   *  takes, the two skips write the funnel's flags and Run Setup launches
   *  the window's setup conversation in the body below. */
  readonly onboarding: {
    readonly signInChatGpt: HostVerb<void>;
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
export interface GuiWindowHost {
  /** The window's notices. */
  readonly notify: Dialogs['notify'];
  readonly bindings: SharedHostCommandBindings;
  readonly own: OwnHostHandlers;
  /** The runtime's notices this host presents its own way. A missing agent
   *  is the window's own banner, so the window's opening answers that one. */
  readonly notices: PresentationEventHandlers<
    Omit<RuntimePresentationEventPayloads, 'agentNotFound'>,
    HostPresentation
  >;
  /** What the window's editor does for its project's runs, here or in the
   *  service. Announcing the files a service task wrote is the same on
   *  every host, so the window's opening adds it. */
  readonly window: Omit<WindowHost, 'filesWritten' | 'emit'>;
  readonly runs: Pick<
    HostRunActionPorts,
    'openFinalOutput' | 'revealProgress'
  > & {
    /** Bring the window's run view into view, so a selection reaches the
     *  surface that brings up. */
    showRunView(): Effect.Effect<void, Error>;
  };
  readonly files: Omit<ProgressDocumentTaskFileActionsHost, 'showInfo'>;
  /** The transcript export's format picker and opener. */
  readonly export: TranscriptExportHost;
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

/** The settings body's verbs on a window's runs: its own session's, never
 *  those of another project its host happens to show. */
export type GuiWindowSettingsRuns = Pick<
  SettingsHostBindings,
  'revealRun' | 'runLabel'
>;

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

/**
 * Open a window of `ports.runs` for the caller's scope. The bridge has a
 * scope of its own, closed off the window's release: it waits for the
 * requests in flight when it closes, up to the session's close deadline, and
 * a launch answers once it starts, so a window that closes neither waits for a
 * run to end nor stops it. The
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
    handleHostCommand: handle,
    onPortClosed: draftRequests.closePort,
  }).pipe(Scope.provide(bridgeScope));
  // Entering the setup step selects the setup agent on the launcher; a
  // snapshot already there leaves a user who switched agents alone. It
  // never starts setup: the user launches it from the setup card.
  const catalog = yield* AgentCatalog;
  yield* Effect.forkScoped(
    snapshot.changes.pipe(
      Stream.map((current) => current.onboarding),
      Stream.changes,
      Stream.filter((step) => step === 'setup'),
      Stream.runForEach(() =>
        Effect.sync(() => {
          // The catalog's key, so the launcher's list matches by value.
          const entry = catalog.get(SETUP_AGENT_NAME);
          bridge.surfaceAction({
            kind: 'launch',
            patch: { agent: entry ? agentKeyOf(entry) : SETUP_AGENT_NAME },
          });
        }),
      ),
    ),
  );
  const host = yield* ports.host({ bridge, snapshot });

  // The window is its project's window wherever its runs run: here,
  // through this process's own windows, or in the service, whose runs ask
  // it for the same. Its own failures before a run opens, it presents
  // itself.
  const workspace = roots.workspace ?? roots.storage;
  const signals = yield* AppSignals;
  // A notice is presented after the request that opened the window has
  // returned, so the banner's read carries its two services with it.
  const bannerServices = Context.pick(
    AgentDirectories,
    FileSystem.FileSystem,
  )(yield* Effect.context<AgentDirectories | FileSystem.FileSystem>());
  const notices: PresentationEventHandlers<
    RuntimePresentationEventPayloads,
    HostPresentation
  > = {
    ...host.notices,
    agentNotFound: ({ agentName }) =>
      Effect.provide(snapshot.showAgentConfigBanner(agentName), bannerServices),
  };
  const window: WindowHost = {
    ...host.window,
    emit: (event, payload) => notices[event](payload),
    // What a service task wrote is announced as a task here announces it:
    // the host's file tree or decorations follow the signal.
    filesWritten: (absolutePaths) =>
      signals.emit('workspaceFilesWritten', {
        absolutePaths: [...absolutePaths],
      }),
  };
  const present = presenterOn(window);
  yield* Effect.forkScoped(
    attachWindowHost(runs.link, workspace, window, ports.focused),
  );
  // The banner says where the window's tasks run when it is not where the
  // user expects: a folder's tasks running here, because the service was
  // out of reach at open; or, while a service window's link holds no
  // service, why (reaching it again, or refused by a newer TeXRA), so the
  // view never sits frozen without saying so.
  const { where } = runs;
  if (where === 'service')
    yield* Effect.forkScoped(
      Stream.runForEach(linkOutage(runs.link), (reason) =>
        snapshot.setServiceBanner(
          reason === null ? null : { kind: 'offline', reason },
        ),
      ),
    );
  else if (where.local !== null)
    yield* snapshot.setServiceBanner({ kind: 'local', reason: where.local });

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
    notify: host.notify,
  });
  const { bindings } = host;
  const runSetup = yield* openWindowSetup({
    session,
    roots,
    start: runActions.runValidated,
    present,
    notify: host.notify,
    showRun: (runId) =>
      host.runs
        .showRunView()
        .pipe(
          Effect.andThen(
            Effect.sync(() => bridge.surfaceAction({ kind: 'select', runId })),
          ),
        ),
    // A previous "Skip for now" is cleared so the card shows again; after a
    // finished task the credential-lost banner stands in its place.
    showConnectModel: setOnboardingDeclined(roots.globalState, false).pipe(
      Effect.andThen(host.runs.showRunView()),
      Effect.andThen(
        Effect.sync(() => bridge.surfaceAction({ kind: 'selectNew' })),
      ),
    ),
  });
  const latexdiff = latexdiffVerbs({
    host: bindings.latexdiff,
    roots,
    session,
    notify: host.notify,
  });
  const documentTaskFileActions = new ProgressDocumentTaskFileActionsController(
    {
      rounds: (runId) => {
        const run = session.view.current().runs.get(runId);
        return run === undefined ? [] : documentRoundsOf(run);
      },
      storageRoot: roots.storage,
      workspace: roots.workspace,
      host: {
        ...host.files,
        showInfo: (message) => host.notify('info', message),
      },
      runs: runActions,
      latexdiff: latexdiff.file,
    },
  );

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
  const exportTranscript = (runId: RunId) =>
    exportRunTranscript(runId, {
      pickFormat: host.export.pickFormat,
      openPath: host.export.openPath,
      notify: host.notify,
      roots,
      session,
    });
  /**
   * One program per shared request, as a host's own handlers are: it runs on the
   * fiber the window's dispatch already owns and finishes nothing, so its
   * failure reaches the bridge's view as the value the port carried.
   */
  function shared(
    request: SharedHostCommand,
    port: string,
  ): HostVerb<HostOutcome> {
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
          yield* documentTaskFileActions.openRunStorage(request.runId);
          return done;
        case 'attachDroppedFiles': {
          const attached = yield* attachDroppedFiles(
            roots.workspace,
            request.paths,
            getIncludedExtensions(request.category),
          );
          if (attached.attachedCount > 0 && attached.rejectedCount > 0) {
            yield* host.notify(
              'info',
              `Attached ${formatResultCount(attached.attachedCount, 'dropped file')}; skipped ${formatResultCount(attached.rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
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
          yield* documentTaskFileActions.handle(request);
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
          yield* latexdiff.run(request.runId);
          return done;
        case 'pack':
        case 'clean':
          yield* runActions.documentTaskFileOperation(
            request.runId,
            request.kind,
          );
          return done;
        case 'latexdiffCommit':
          yield* latexdiff.againstCommit(
            request.action,
            request.baseFile ?? '',
            request.commit ?? 'HEAD',
          );
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
              if (!request.customDirSet) {
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
          yield* snapshot.refreshHostBanners;
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
              yield* setOnboardingDeclined(roots.globalState, true);
              return done;
            case 'runSetup':
              yield* runSetup;
              return done;
            case 'skipSetup':
              yield* setFirstRunDone(roots.globalState);
              return done;
            case 'openGettingStarted':
              yield* bindings.onboarding.openGettingStarted;
              return done;
          }
          return done;
      }
    });
  }
  /** An own kind the host binds runs its handler; one it leaves out is
   *  refused, worded here for both hosts. */
  const own = (
    request: OwnHostCommand,
    port: string,
  ): HostVerb<HostOutcome> => {
    const handler = host.own[request.kind];
    if (handler === undefined)
      return Effect.fail(
        new Rejected({
          reason: `${OWN_REQUEST_LABEL[request.kind]} is not available in this app.`,
        }),
      );
    // cast: the handler bound under `request.kind` takes a request of that kind.
    return (
      handler as (
        request: OwnHostCommand,
        port: string,
      ) => HostVerb<HostOutcome>
    )(request, port);
  };
  function handle(
    request: HostCommand,
    port: string,
  ): Effect.Effect<HostOutcome, HostCommandFailure, ProcessServices> {
    return Effect.provide(
      isOwnHostCommand(request) ? own(request, port) : shared(request, port),
      requestLayer,
    );
  }

  const settingsRuns: GuiWindowSettingsRuns = {
    revealRun: (runId) =>
      session.view.current().runs.has(runId)
        ? host.runs
            .showRunView()
            .pipe(
              Effect.andThen(
                Effect.sync(() =>
                  bridge.surfaceAction({ kind: 'select', runId }),
                ),
              ),
              Effect.as('revealed' as const),
            )
        : Effect.succeed('missing' as const),
    runLabel: (runId) => session.view.current().runs.get(runId)?.label,
  };

  return {
    bridge,
    snapshot,
    present,
    runValidated: runActions.runValidated,
    runSetup,
    settingsRuns,
  };
});
