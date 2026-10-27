/**
 * The `host` snapshot of one session (PRD one-fold-three-renderers, 8.1):
 * what the shell renders but does not own. It rides on every frame that
 * follows a change and on every subscribe, so a surface never asks for a
 * catalog and never holds a stale one. Every producer is a read the host
 * already owns; nothing here is a fact about a run (`SessionView`) or a
 * choice of the user's (`Surface`). The catalogs and the recent commits are
 * host-neutral; the host injects its file lists and the banners only it can
 * answer (a VS Code host knows its API-key status, its missing tools, and
 * how to start a project; the desktop keeps the first two in Settings).
 */
import {
  Cause,
  Effect,
  Exit,
  type FileSystem,
  type Path,
  Schema,
} from 'effect';
import {
  AgentDirectories,
  getEnabledModels,
  readModelOptions,
  type PlatformSecrets,
  type PerKeyLane,
  Settings,
  withPerKeyLane,
} from '@texra-ai/harness';
import {
  APPROVAL_POLICY_CONFIG_KEY,
  type ApprovalPolicy,
} from '@texra-ai/harness/schemas';
import { loadTeamOptions } from '@texra-ai/harness';
import type {
  FileOptions,
  HostSnapshot,
  ProjectDisplay,
} from '@texra/shared/session/hostSnapshot';
import { agentOptionsData } from '@texra/tools/documents/documentTask';
import { modelOptionsFrom } from '@texra/model/modelOptions';
import { createTeamCatalogPorts } from '@texra/controllers/mainView/teamCatalogPorts';
import { readRecentCommits } from '@texra/utils/git/repositoryOverview';
import type { AgentCatalog, SettingsStores } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

type Banners = HostSnapshot['banners'];

/**
 * One of the host's own snapshot reads failed. The members below are the
 * reads only a host can answer (its file lists and the two banners it alone
 * knows about), so the failure is the host's and carries it.
 * `member` says which producer kept its last value: every read here is
 * guarded, so a failure never blanks the shell.
 */
export class HostSnapshotReadFailed extends Schema.TaggedError<HostSnapshotReadFailed>()(
  'HostSnapshotReadFailed',
  {
    member: Schema.Literals([
      'fileOptions',
      'apiKeyBanner',
      'dependencyBanner',
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

interface HostSnapshotSourceOptions {
  project: ProjectDisplay;
  /** The project folder the recent commits are read from; `undefined` for a
   *  session with no folder open, which is never a repository. */
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
  /** The process secret store, read by the model catalog's availability
   *  answers. The host root that owns it threads it in beside
   *  {@link HostSnapshotSourceOptions.stores}. */
  secrets: PlatformSecrets;
  /** The launcher's single-slot catalogs: base and edited candidates. The
   *  read takes the process `FileSystem` and `Path` from context; the
   *  refresh effects that reach it carry the requirement. */
  fileOptions(): Effect.Effect<
    FileOptions,
    HostSnapshotReadFailed,
    FileSystem.FileSystem | Path.Path
  >;
  /** The launcher's root picker; empty where a session has exactly one. */
  workspaceRoots?: () => HostSnapshot['workspaceRoots'];
  /** Hosts that surface these outside Settings answer them; absent means
   *  never shown. */
  apiKeyBanner?: () => Effect.Effect<Banners['apiKey'], HostSnapshotReadFailed>;
  dependencyBanner?: () => Effect.Effect<
    Banners['dependency'],
    HostSnapshotReadFailed,
    ChildProcessSpawner
  >;
  /** A host that can start a project (a sample, an Overleaf clone, an arXiv
   *  download) offers it while the folder has no LaTeX files; absent means
   *  never shown. */
  gettingStartedBanner?: true;
  /** Write directly to the bridge's host snapshot, which its runs replay. */
  publish(snapshot: HostSnapshot): Effect.Effect<void>;
  onError(error: unknown): void;
}

export interface HostSnapshotSource {
  /** Reassemble every catalog and publish the result. */
  readonly refresh: Effect.Effect<
    void,
    never,
    AgentCatalog | FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  >;
  /** The agent, team, and model catalogs changed (an agent list edit, a
   *  credential, a sign-in). */
  readonly refreshCatalogs: Effect.Effect<void, never, AgentCatalog>;
  /** The project's files changed on disk, or the surface asked for a relist. */
  readonly refreshFiles: Effect.Effect<
    void,
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly refreshCommits: Effect.Effect<void, never, ChildProcessSpawner>;
  /** The host's own banners changed (a key stored, a tool installed). */
  readonly refreshHostBanners: Effect.Effect<void, never, ChildProcessSpawner>;
  /** The workspace folders changed. */
  refreshWorkspaceRoots(): Effect.Effect<void>;
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
  dismissBanner(banner: 'gettingStarted' | 'dependency'): Effect.Effect<void>;
  setOnboarding(state: HostSnapshot['onboarding']): Effect.Effect<void>;
  /** Why the service link holds no service (`ServiceLink.away`), or null
   *  once it reached it again. */
  setServiceOffline(reason: string | null): Effect.Effect<void>;
}

/** The project's display record and the catalogs, assembled per session. */
export function createHostSnapshotSource(
  options: HostSnapshotSourceOptions,
): HostSnapshotSource {
  let catalogs: Pick<
    HostSnapshot,
    'agentOptions' | 'modelOptions' | 'teamOptions'
  > = {
    agentOptions: [],
    modelOptions: [],
    teamOptions: [],
  };
  let fileOptions: FileOptions = {
    baseFile: [],
    editedFile: [],
    commit: ['HEAD'],
  };
  let hasInputFiles = true;
  let commits: { commits: string[]; isGitRepo: boolean } = {
    commits: [],
    isGitRepo: false,
  };
  let apiKey: Banners['apiKey'] = { visible: false };
  let dependency: Banners['dependency'] = { visible: false };
  let recording: HostSnapshot['recording'] = null;
  let agentConfig: Banners['agentConfig'] = { visible: false };
  let onboarding: HostSnapshot['onboarding'] = 'done';
  let serviceOffline: string | null = null;
  // A dismissal lasts the session.
  const dismissed = new Set<'gettingStarted' | 'dependency'>();

  const publish = Effect.suspend(() =>
    options.publish({
      project: options.project,
      approvalPolicy: Settings.getConfig<ApprovalPolicy>(
        options.stores.config,
        APPROVAL_POLICY_CONFIG_KEY,
      ),
      ...catalogs,
      workspaceRoots: options.workspaceRoots?.() ?? [],
      fileOptions: { ...fileOptions, commit: ['HEAD', ...commits.commits] },
      isGitRepo: commits.isGitRepo,
      recording,
      banners: {
        apiKey,
        agentConfig,
        dependency: {
          ...dependency,
          visible: dependency.visible && !dismissed.has('dependency'),
        },
        gettingStarted:
          options.gettingStartedBanner === true &&
          !hasInputFiles &&
          !dismissed.has('gettingStarted'),
        serviceOffline,
      },
      onboarding,
    }),
  );

  // The three catalog loads run concurrently, so each reads its value first
  // and only then spreads `catalogs`. Spreading before a `yield*` captures
  // the record as it was when the load started and writes that copy back on
  // resume, erasing whatever a sibling load stored in between.
  const loadAgents = Effect.gen(function* () {
    const agentOptions = yield* agentOptionsData(options.stores);
    catalogs = { ...catalogs, agentOptions };
  });

  const loadTeams = Effect.gen(function* () {
    const teamOptions = loadTeamOptions(
      yield* createTeamCatalogPorts(options.stores.repoState),
    );
    catalogs = { ...catalogs, teamOptions };
  });

  const loadModels = Effect.gen(function* () {
    const models = yield* readModelOptions(
      { ...options.stores, secrets: options.secrets },
      yield* getEnabledModels(options.stores.globalState),
    );
    catalogs = { ...catalogs, modelOptions: modelOptionsFrom(models) };
  });

  const loadFiles = Effect.gen(function* () {
    fileOptions = yield* options.fileOptions();
    hasInputFiles = fileOptions.baseFile.length > 0;
  });

  const loadCommits = Effect.gen(function* () {
    if (options.root === undefined) return;
    commits = yield* readRecentCommits(
      options.root,
      yield* Settings.get<number>(
        options.stores,
        'texra.git.numberOfCommitsToShow',
      ),
      { settings: options.stores, onError: options.onError },
    );
  });

  const loadHostBanners = Effect.gen(function* () {
    const [key, tools] = yield* Effect.all(
      [
        options.apiKeyBanner
          ? options.apiKeyBanner()
          : Effect.succeed(undefined),
        options.dependencyBanner
          ? options.dependencyBanner()
          : Effect.succeed(undefined),
      ],
      { concurrency: 'unbounded' },
    );
    if (key) apiKey = key;
    if (tools) dependency = tools;
  });

  /** One lane for every refresh of this source: the producers write the
   *  fields above and `publish` reads them, so two refreshes in flight at
   *  once (a burst of file-watcher events, a catalog reload during a full
   *  refresh) would let the slower, older read publish last and leave the
   *  shell showing a state no later event corrects. In lane order the last
   *  refresh asked for is the last to publish. */
  const refreshLanes = new Map<'refresh', PerKeyLane>();

  /** Each producer settles on its own: one that fails is reported and keeps
   *  its last value, and the snapshot still publishes what the others read,
   *  so a single unavailable source never leaves the shell blank. */
  const guarded = <R>(
    ...loads: Effect.Effect<void, Error, R>[]
  ): Effect.Effect<void, never, R> =>
    Effect.gen(function* () {
      const settled = yield* Effect.forEach(
        loads,
        (load) => Effect.exit(load),
        { concurrency: 'unbounded' },
      );
      // An interrupted load is not a failure to report.
      for (const exit of settled) {
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
          options.onError(Cause.squash(exit.cause));
      }
      yield* publish;
    }).pipe(withPerKeyLane(refreshLanes, 'refresh'));

  const catalogLoads = [loadAgents, loadTeams, loadModels];

  return {
    refresh: guarded<
      AgentCatalog | FileSystem.FileSystem | Path.Path | ChildProcessSpawner
    >(...catalogLoads, loadFiles, loadCommits, loadHostBanners),
    refreshCatalogs: guarded<AgentCatalog>(...catalogLoads),
    refreshFiles: guarded(loadFiles),
    refreshCommits: guarded(loadCommits),
    refreshHostBanners: guarded(loadHostBanners),
    refreshWorkspaceRoots: () => publish,
    setRecording: (next) =>
      Effect.sync(() => {
        recording = next;
      }).pipe(Effect.andThen(publish)),
    showAgentConfigBanner: Effect.fn(
      'hostSnapshotSource.showAgentConfigBanner',
    )(function* (agentName) {
      // An unreadable setting is reported and the banner offers the agent
      // settings, which always open, instead of a directory it cannot name.
      const customDirSet = yield* Effect.flatMap(AgentDirectories, (dirs) =>
        dirs.customConfigured(),
      ).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            options.onError(cause);
            return false;
          }),
        ),
      );
      agentConfig = { visible: true, agentName, customDirSet };
      yield* publish;
    }),
    clearAgentConfigBanner: Effect.suspend(() => {
      if (!agentConfig.visible) return Effect.void;
      agentConfig = { visible: false };
      return publish;
    }),
    dismissBanner: (banner) =>
      Effect.sync(() => {
        dismissed.add(banner);
      }).pipe(Effect.andThen(publish)),
    setOnboarding: (state) =>
      Effect.suspend(() => {
        if (state === onboarding) return Effect.void;
        onboarding = state;
        return publish;
      }),
    setServiceOffline: (reason) =>
      Effect.suspend(() => {
        if (reason === serviceOffline) return Effect.void;
        serviceOffline = reason;
        return publish;
      }),
  };
}
