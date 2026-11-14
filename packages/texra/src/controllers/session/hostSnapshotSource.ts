/**
 * The `host` snapshot of one session:
 * what the shell renders but does not own. It rides on every frame that
 * follows a change and on every subscribe, so a surface never asks for a
 * catalog and never holds a stale one. Every producer is a read the host
 * already owns; nothing here is a fact about a run (`SessionView`) or a
 * choice of the user's (`Surface`). The catalogs, the recent commits and the
 * onboarding funnel are host-neutral; the host injects its file lists, its
 * missing-tool check, and which notices it shows (a VS Code window shows the
 * lost-credential banner and offers to start a project; the desktop keeps
 * the first in Settings).
 *
 * The source holds one `SubscriptionRef` of its inputs. Each producer reads
 * and then writes its own fields, so the last write of a field wins and no
 * producer waits on another; the snapshot is the inputs mapped, so a field
 * derived from several inputs (the funnel, a banner's visibility) is never
 * stored.
 */
import {
  Effect,
  type FileSystem,
  Option,
  type Path,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import {
  AgentDirectories,
  AppState,
  appSignalStream,
  getEnabledModels,
  readModelOptions,
  workspaceEnvironmentLayer,
} from '@texra-ai/harness/host';
import {
  Settings,
  withLogChannel,
  type AppSignals,
  type Secrets,
  type SettingsStores,
} from '@texra-ai/harness/plugins';
import { APPROVAL_POLICY_SETTING } from '@texra-ai/harness/schemas';
import { GIT_COMMITS_TO_SHOW_SETTING } from '@texra/shared/settings/texraSettings';
import { loadTeamOptions } from '@texra/agent/teams/teamLaunch';
import type {
  FileOptions,
  HostSnapshot,
  MissingTool,
  ProjectDisplay,
} from '@texra/shared/session/hostSnapshot';
import { agentOptionsData } from '@texra/tools/documents/documentTask';
import { modelOptionsFrom } from '@texra/model/modelOptions';
import { hasUsableSetupCredential } from '@texra/model/setupCredentialAccess';
import { createTeamCatalogPorts } from '@texra/controllers/mainView/teamCatalogPorts';
import {
  deriveOnboardingFunnelState,
  ONBOARDING_FLAG_KEYS,
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import { readRecentCommits } from '@texra/utils/git/repositoryOverview';
import type { AgentCatalog } from '@texra-ai/harness/host';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { SubscriptionAccounts } from '@texra-ai/llm/node';

const CHANNEL = 'Host Snapshot';

type DismissibleBanner = 'gettingStarted' | 'dependency';

interface HostSnapshotSourceOptions {
  project: ProjectDisplay;
  tools: HostSnapshot['tools'];
  /** The project folder the recent commits are read from and whose `.env`
   *  the credential check reads; `undefined` for a session with no folder
   *  open, which is never a repository. */
  root: string | undefined;
  /**
   * The owning session's three setting slots: its workspace-scoped team and
   * agent list state, its configuration, and the process global state. The model
   * catalog's availability read resolves the routing switches and the two
   * "prefer my subscription" preferences against these, so a host with several
   * open projects in one process answers for the project this source belongs
   * to.
   */
  stores: SettingsStores;
  /** The launcher's single-slot catalogs: base and edited candidates. The
   *  read takes the process `FileSystem` and `Path` from context; the
   *  refresh effects that reach it carry the requirement. */
  fileOptions(): Effect.Effect<
    FileOptions,
    Error,
    FileSystem.FileSystem | Path.Path
  >;
  /** The launcher's root picker; empty where a session has exactly one. */
  workspaceRoots(): HostSnapshot['workspaceRoots'];
  /** The tools TeXRA needs that this machine lacks. */
  missingTools(): Effect.Effect<
    readonly MissingTool[],
    never,
    ChildProcessSpawner
  >;
  /** The notices this host shows: the lost-credential banner, and the offer
   *  to start a project (a sample, an Overleaf clone, an arXiv download)
   *  while the folder has no LaTeX files. */
  shows: { readonly apiKeyBanner: boolean; readonly gettingStarted: boolean };
}

/** What the producers write; the snapshot is {@link snapshotOf} of it. */
interface Inputs {
  /** False until the first {@link HostSnapshotSource.refresh} has finished,
   *  so the shell never paints the empty catalogs. */
  readonly loaded: boolean;
  readonly catalogs: Pick<
    HostSnapshot,
    'agentOptions' | 'modelOptions' | 'teamOptions'
  >;
  readonly workspaceRoots: HostSnapshot['workspaceRoots'];
  readonly fileOptions: FileOptions;
  readonly commits: { readonly commits: string[]; readonly isGitRepo: boolean };
  readonly missingTools: readonly MissingTool[];
  readonly recording: HostSnapshot['recording'];
  readonly agentConfig: HostSnapshot['banners']['agentConfig'];
  readonly service: HostSnapshot['banners']['service'];
  /** A dismissal lasts the session. */
  readonly dismissed: ReadonlySet<DismissibleBanner>;
  /** Whether a usable credential exists; undefined until a check answers. */
  readonly credential: boolean | undefined;
  /** The user's onboarding flags; undefined until a read answers, which is
   *  not "never skipped, no run yet". */
  readonly flags:
    | { readonly declined: boolean; readonly firstRunDone: boolean }
    | undefined;
}

export interface HostSnapshotSource {
  /** The snapshot as the inputs change, from the first refresh on. */
  readonly changes: Stream.Stream<HostSnapshot>;
  /** Whether a usable credential exists, as each check answers. */
  readonly credentialUsable: Stream.Stream<boolean>;
  /** Read every input again. */
  readonly refresh: Effect.Effect<
    void,
    never,
    | AgentCatalog
    | Secrets
    | SubscriptionAccounts
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner
  >;
  /** The agent, team, and model catalogs changed (an agent list edit, a
   *  credential, a sign-in). The model catalog reads the process `Secrets`
   *  and its subscription accounts. */
  readonly refreshCatalogs: Effect.Effect<
    void,
    never,
    AgentCatalog | Secrets | SubscriptionAccounts
  >;
  /** The project's files changed on disk, or the surface asked for a relist. */
  readonly refreshFiles: Effect.Effect<
    void,
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly refreshCommits: Effect.Effect<void, never, ChildProcessSpawner>;
  /** The host's own banners changed (a key stored, a tool installed): the
   *  credential and the missing tools are checked again. */
  readonly refreshHostBanners: Effect.Effect<
    void,
    never,
    ChildProcessSpawner | Secrets | SubscriptionAccounts
  >;
  /** The workspace folders changed. */
  readonly refreshWorkspaceRoots: Effect.Effect<void>;
  /** The one recorder per process started or stopped. */
  setRecording(recording: HostSnapshot['recording']): Effect.Effect<void>;
  /** A launch could not find its agent: the banner's actions edit the
   *  agents, and open the custom agent directory only when the user
   *  configured one. */
  showAgentConfigBanner(
    agentName: string,
  ): Effect.Effect<void, never, AgentDirectories | FileSystem.FileSystem>;
  /** A launch resolved its agent and started a run, so the missing-agent
   *  warning no longer describes the launcher. */
  readonly clearAgentConfigBanner: Effect.Effect<void>;
  /** The user dismissed a notice for the rest of this session. */
  dismissBanner(banner: DismissibleBanner): Effect.Effect<void>;
  /** Where the window's tasks run, when the user should be told: its
   *  service link holds no service (`ServiceLink.away`), or its folder's
   *  tasks run in this process; null otherwise. */
  setServiceBanner(
    banner: HostSnapshot['banners']['service'],
  ): Effect.Effect<void>;
}

/** A failed read keeps its fields' last values and says why at `warn`, so
 *  a single unavailable source never blanks the shell. */
const keepOnFailure =
  (what: string) =>
  <R>(load: Effect.Effect<void, Error, R>): Effect.Effect<void, never, R> =>
    load.pipe(
      Effect.catch((error) =>
        Effect.logWarning(`The host snapshot could not read ${what}`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
        ),
      ),
    );

/**
 * The project's display record and the catalogs, assembled per session for
 * the caller's scope: the scope holds the followers of the onboarding flags
 * and of credential changes.
 */
export const openHostSnapshotSource = Effect.fn('openHostSnapshotSource')(
  function* (
    options: HostSnapshotSourceOptions,
  ): Effect.fn.Return<
    HostSnapshotSource,
    never,
    Scope.Scope | AppState | AppSignals | Secrets | SubscriptionAccounts
  > {
    const { stores } = options;
    const appState = yield* AppState;
    const inputs = yield* SubscriptionRef.make<Inputs>({
      loaded: false,
      catalogs: { agentOptions: [], modelOptions: [], teamOptions: [] },
      workspaceRoots: options.workspaceRoots(),
      fileOptions: { baseFile: [], editedFile: [], commit: ['HEAD'] },
      commits: { commits: [], isGitRepo: false },
      missingTools: [],
      recording: null,
      agentConfig: null,
      service: null,
      dismissed: new Set(),
      credential: undefined,
      flags: undefined,
    });
    /** Write `patch` when it changes a field, so an unchanged write
     *  publishes nothing. */
    const write = (patch: Partial<Inputs>) =>
      SubscriptionRef.updateSome(inputs, (current) =>
        Object.entries(patch).some(
          // cast: `Object.entries` widens keys to string; `patch` is a
          // `Partial<Inputs>`, so each key is one of `Inputs`.
          ([key, value]) => current[key as keyof Inputs] !== value,
        )
          ? Option.some({ ...current, ...patch })
          : Option.none(),
      );

    /**
     * One producer: its read, then its write. Two reads of one producer in
     * flight (a burst of file-watcher events) run in the order they were
     * asked for, so the older read never lands last; different producers
     * never wait on each other.
     */
    const producer = Effect.fnUntraced(function* <R>(
      what: string,
      load: Effect.Effect<void, Error, R>,
    ) {
      const lane = yield* Semaphore.make(1);
      return keepOnFailure(what)(load).pipe(lane.withPermit);
    });

    const loadAgents = yield* producer(
      'the agents',
      Effect.gen(function* () {
        const agentOptions = yield* agentOptionsData(stores);
        yield* SubscriptionRef.update(inputs, (s) => ({
          ...s,
          catalogs: { ...s.catalogs, agentOptions },
        }));
      }),
    );
    const loadTeams = yield* producer(
      'the teams',
      Effect.gen(function* () {
        const teamOptions = loadTeamOptions(
          yield* createTeamCatalogPorts(stores.repoState),
        );
        yield* SubscriptionRef.update(inputs, (s) => ({
          ...s,
          catalogs: { ...s.catalogs, teamOptions },
        }));
      }),
    );
    const loadModels = yield* producer(
      'the models',
      Effect.gen(function* () {
        const models = yield* readModelOptions(
          stores,
          yield* getEnabledModels(stores),
        );
        const modelOptions = modelOptionsFrom(models);
        yield* SubscriptionRef.update(inputs, (s) => ({
          ...s,
          catalogs: { ...s.catalogs, modelOptions },
        }));
      }),
    );
    const loadFiles = yield* producer(
      'the project files',
      Effect.flatMap(options.fileOptions(), (fileOptions) =>
        write({ fileOptions }),
      ),
    );
    const loadCommits = yield* producer(
      'the recent commits',
      Effect.gen(function* () {
        if (options.root === undefined) return;
        const commits = yield* readRecentCommits(
          options.root,
          yield* Settings.get(stores, GIT_COMMITS_TO_SHOW_SETTING),
        ).pipe(withLogChannel(CHANNEL));
        yield* write({ commits });
      }),
    );
    const loadDependencies = yield* producer(
      'the missing tools',
      Effect.flatMap(options.missingTools(), (missingTools) =>
        write({ missingTools }),
      ),
    );
    // Asked under the project's `.env` over the process's: the key a run of
    // this project would use.
    const loadCredential = yield* producer(
      'the provider credentials',
      hasUsableSetupCredential(stores).pipe(
        Effect.provide(workspaceEnvironmentLayer(options.root)),
        Effect.flatMap((credential) => write({ credential })),
      ),
    );
    const loadFlags = yield* producer(
      'the onboarding flags',
      Effect.flatMap(readOnboardingFlags(appState), (flags) =>
        write({ flags }),
      ),
    );

    const catalogs = Effect.all([loadAgents, loadTeams, loadModels], {
      concurrency: 'unbounded',
      discard: true,
    });
    const hostBanners = Effect.all([loadCredential, loadDependencies], {
      concurrency: 'unbounded',
      discard: true,
    });

    // The flags are user-scoped and may be written by another process; the
    // credential changes with any stored key or sign-in.
    yield* appState.changes(ONBOARDING_FLAG_KEYS).pipe(
      Stream.runForEach(() => loadFlags),
      Effect.forkScoped,
    );
    yield* appSignalStream('credentialChanged').pipe(
      Stream.runForEach(() => loadCredential),
      Effect.forkScoped,
    );
    // Configuring a credential clears a previous "Skip for now", so a user
    // who later loses every credential sees the picker again.
    yield* SubscriptionRef.changes(inputs).pipe(
      Stream.map((s) => s.flags?.declined === true && s.credential === true),
      Stream.changes,
      Stream.filter(Boolean),
      Stream.runForEach(() =>
        setOnboardingDeclined(appState, false).pipe(
          Effect.catch((error) =>
            Effect.logWarning('Clearing the onboarding skip failed').pipe(
              Effect.annotateLogs({ data: error }),
              withLogChannel(CHANNEL),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const snapshotOf = (s: Inputs): HostSnapshot => ({
      project: options.project,
      tools: options.tools,
      approvalPolicy: Settings.getConfig(
        stores.config,
        APPROVAL_POLICY_SETTING,
      ),
      ...s.catalogs,
      workspaceRoots: s.workspaceRoots,
      fileOptions: {
        ...s.fileOptions,
        commit: ['HEAD', ...s.commits.commits],
      },
      isGitRepo: s.commits.isGitRepo,
      recording: s.recording,
      banners: {
        // A credential that worked stopped working: raised only once a task
        // has finished; before that the "Connect a model" card is the prompt.
        apiKey:
          options.shows.apiKeyBanner &&
          s.credential === false &&
          s.flags?.firstRunDone === true,
        agentConfig: s.agentConfig,
        dependency:
          s.missingTools.length > 0 && !s.dismissed.has('dependency')
            ? s.missingTools
            : null,
        gettingStarted:
          options.shows.gettingStarted &&
          s.fileOptions.baseFile.length === 0 &&
          !s.dismissed.has('gettingStarted'),
        service: s.service,
      },
      // An unanswered check or flag read is not "no credential" or "not
      // done": until both answer, the funnel stays out of the way.
      onboarding:
        s.credential === undefined || s.flags === undefined
          ? 'done'
          : deriveOnboardingFunnelState({
              hasCredential: s.credential,
              ...s.flags,
            }),
    });

    return {
      changes: SubscriptionRef.changes(inputs).pipe(
        Stream.filter((s) => s.loaded),
        Stream.map(snapshotOf),
      ),
      credentialUsable: SubscriptionRef.changes(inputs).pipe(
        Stream.map((s) => s.credential),
        Stream.filter((credential) => credential !== undefined),
        Stream.changes,
      ),
      refresh: Effect.all(
        [catalogs, loadFiles, loadCommits, hostBanners, loadFlags],
        { concurrency: 'unbounded', discard: true },
      ).pipe(Effect.andThen(write({ loaded: true }))),
      refreshCatalogs: catalogs,
      refreshFiles: loadFiles,
      refreshCommits: loadCommits,
      refreshHostBanners: hostBanners,
      refreshWorkspaceRoots: Effect.suspend(() =>
        write({ workspaceRoots: options.workspaceRoots() }),
      ),
      setRecording: (recording) => write({ recording }),
      showAgentConfigBanner: Effect.fn(
        'hostSnapshotSource.showAgentConfigBanner',
      )(function* (agentName) {
        // An unreadable setting is reported and the banner offers the agent
        // settings, which always open, instead of a directory it cannot name.
        const customDirSet = yield* Effect.flatMap(AgentDirectories, (dirs) =>
          dirs.customConfigured(),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              'Whether a custom agent directory is set could not be read',
            ).pipe(
              Effect.annotateLogs({ data: cause }),
              withLogChannel(CHANNEL),
              Effect.as(false),
            ),
          ),
        );
        yield* write({ agentConfig: { agentName, customDirSet } });
      }),
      clearAgentConfigBanner: SubscriptionRef.updateSome(inputs, (s) =>
        s.agentConfig !== null
          ? Option.some({ ...s, agentConfig: null })
          : Option.none(),
      ),
      dismissBanner: (banner) =>
        SubscriptionRef.updateSome(inputs, (s) =>
          s.dismissed.has(banner)
            ? Option.none()
            : Option.some({
                ...s,
                dismissed: new Set([...s.dismissed, banner]),
              }),
        ),
      setServiceBanner: (service) => write({ service }),
    };
  },
);
