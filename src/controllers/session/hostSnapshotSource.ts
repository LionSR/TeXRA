/**
 * The `host` snapshot of one session (PRD one-fold-three-renderers, 8.1):
 * what the shell renders but does not own. It rides on every frame that
 * follows a change and on every subscribe, so a surface never asks for a
 * catalog and never holds a stale one. Every producer is a read the host
 * already owns; nothing here is a fact about a run (`SessionView`) or a
 * choice of the user's (`Surface`). The catalogs are host-neutral; the
 * host injects its file lists, its git probe, and the banners only it can
 * answer (a VS Code host knows its API-key status and
 * its missing tools; the desktop keeps both in Settings). The sign-in probe
 * is the account plane's own read, yielded from `SupabaseAuth`.
 */
import { Cause, Data, Effect, Exit, type FileSystem } from 'effect';
import { computeAgentOptionsData } from '@agent/index';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import {
  getEnabledModels,
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import type {
  AgentDirectories,
  StateStore,
  StateWriteFailed,
} from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { type FileOptions, type SessionType } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type {
  HostSnapshot,
  ProjectDisplay,
} from '@shared/session/hostSnapshot';

type Banners = HostSnapshot['banners'];

/**
 * One of the host's own snapshot reads failed. The members below are the
 * reads only a host can answer — its file lists, its git probe, and the two
 * banners it alone knows about — so the failure is the host's and carries it.
 * `member` says which producer kept its last value: every read here is
 * guarded, so a failure never blanks the shell. The sign-in probe is no
 * longer a port: both GUI hosts bottomed out in the account plane's own
 * infallible `authenticated` read, so the source yields `SupabaseAuth`
 * directly.
 */
export class HostSnapshotReadFailed extends Data.TaggedError(
  'HostSnapshotReadFailed',
)<{
  readonly member:
    'fileOptions' | 'readRecentCommits' | 'apiKeyBanner' | 'dependencyBanner';
  readonly message: string;
  readonly cause: unknown;
}> {}

interface HostSnapshotSourceOptions {
  project: ProjectDisplay;
  /**
   * The owning session's three setting slots: its workspace-scoped team and
   * roster state, its configuration, and the process global state. The model
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
   *  read takes the process `FileSystem` from context; the refresh effects
   *  that reach it carry the requirement. */
  fileOptions(): Effect.Effect<
    FileOptions,
    HostSnapshotReadFailed,
    FileSystem.FileSystem
  >;
  readRecentCommits(): Effect.Effect<
    { commits: string[]; isGitRepo: boolean },
    HostSnapshotReadFailed
  >;
  /** The launcher's root picker; empty where a session has exactly one. */
  workspaceRoots?: () => HostSnapshot['workspaceRoots'];
  /** Hosts that surface these outside Settings answer them; absent means
   *  never shown. */
  apiKeyBanner?: () => Effect.Effect<
    Banners['apiKey'],
    HostSnapshotReadFailed,
    LanguageModel
  >;
  dependencyBanner?: () => Effect.Effect<
    Banners['dependency'],
    HostSnapshotReadFailed
  >;
  /** Write directly to the bridge's host snapshot, which its runs replay. */
  publish(snapshot: HostSnapshot): Effect.Effect<void>;
  onError(error: unknown): void;
}

export interface HostSnapshotSource {
  /** Reassemble every catalog and publish the result. */
  readonly refresh: Effect.Effect<
    void,
    never,
    | GlobalStorageFs
    | LanguageModel
    | SupabaseAuth
    | FileSystem.FileSystem
    | AgentDirectories
  >;
  /** The agent, team, and model catalogs changed (a roster edit, a
   *  credential, a sign-in). */
  readonly refreshCatalogs: Effect.Effect<
    void,
    never,
    GlobalStorageFs | LanguageModel | FileSystem.FileSystem | AgentDirectories
  >;
  /** The project's files changed on disk, or the surface asked for a relist. */
  readonly refreshFiles: Effect.Effect<void, never, FileSystem.FileSystem>;
  readonly refreshCommits: Effect.Effect<void>;
  /** The sign-in state changed. */
  readonly refreshAuth: Effect.Effect<void, never, SupabaseAuth>;
  /** The host's own banners changed (a key stored, a tool installed). */
  readonly refreshHostBanners: Effect.Effect<void, never, LanguageModel>;
  /** The workspace folders changed. */
  refreshWorkspaceRoots(): Effect.Effect<void>;
  /** The one recorder per process started or stopped. */
  setRecording(recording: HostSnapshot['recording']): Effect.Effect<void>;
  /** A run loaded an agent from the custom directory, under the category
   *  it was launched as: the banner's actions edit that catalog. */
  showAgentConfigBanner(
    agentName: string,
    sessionType: SessionType,
  ): Effect.Effect<void>;
  /** The user dismissed one of the dismissable banners. The login dismissal
   *  is the one that persists, so the caller runs the write it returns. */
  dismissBanner(
    banner: 'login' | 'gettingStarted' | 'dependency',
  ): Effect.Effect<void, StateWriteFailed>;
  setOnboarding(state: HostSnapshot['onboarding']): Effect.Effect<void>;
}

/** The project's display record and the catalogs, assembled per session. */
export function createHostSnapshotSource(
  options: HostSnapshotSourceOptions,
): HostSnapshotSource {
  let catalogs: Pick<
    HostSnapshot,
    'agentOptions' | 'modelOptions' | 'teamOptions'
  > = {
    agentOptions: { toolUse: [], workflow: [] },
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
  let authenticated = true;
  let loginBannerDismissed = false;
  let apiKey: Banners['apiKey'] = { visible: false };
  let dependency: Banners['dependency'] = { visible: false };
  let recording: HostSnapshot['recording'] = null;
  let agentConfig: Banners['agentConfig'] = { visible: false };
  let onboarding: HostSnapshot['onboarding'] = 'done';
  // The login banner's dismissal is the host's persisted record; the other
  // two last a session.
  const dismissed = new Set<'gettingStarted' | 'dependency'>();

  const publish = Effect.suspend(() =>
    options.publish({
      project: options.project,
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
        gettingStarted: !hasInputFiles && !dismissed.has('gettingStarted'),
        login: !authenticated && !loginBannerDismissed,
      },
      onboarding,
    }),
  );

  const loadAgents = Effect.gen(function* () {
    catalogs = {
      ...catalogs,
      agentOptions: yield* computeAgentOptionsData(options.stores),
    };
  });

  const loadTeams = Effect.gen(function* () {
    catalogs = {
      ...catalogs,
      teamOptions: yield* loadTeamOptions(
        yield* createTeamCatalogPorts(options.stores.workspaceState),
      ),
    };
  });

  const loadModels = Effect.gen(function* () {
    const inputs = yield* readModelAvailabilityInputs(
      { ...options.stores, secrets: options.secrets },
      yield* getEnabledModels(options.stores.globalState),
    );
    catalogs = { ...catalogs, modelOptions: modelOptionsFrom(inputs) };
  });

  const loadFiles = Effect.gen(function* () {
    fileOptions = yield* options.fileOptions();
    hasInputFiles = fileOptions.baseFile.length > 0;
  });

  const loadCommits = Effect.gen(function* () {
    commits = yield* options.readRecentCommits();
  });

  const loadAuth = Effect.gen(function* () {
    loginBannerDismissed = yield* options.stores.globalState.get<boolean>(
      GlobalStateKey.LOGIN_BANNER_DISMISSED,
      false,
    );
    authenticated = yield* Effect.flatMap(
      SupabaseAuth,
      (auth) => auth.authenticated,
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

  /** Each producer settles on its own: one that fails is reported and keeps
   *  its last value, and the snapshot still publishes what the others read,
   *  so a single unavailable source never leaves the shell blank. */
  const guarded = <R>(
    ...loads: Effect.Effect<void, unknown, R>[]
  ): Effect.Effect<void, never, R> =>
    Effect.gen(function* () {
      const settled = yield* Effect.forEach(
        loads,
        (load) => Effect.exit(load),
        { concurrency: 'unbounded' },
      );
      for (const exit of settled) {
        if (Exit.isFailure(exit)) options.onError(Cause.squash(exit.cause));
      }
      yield* publish;
    });

  const catalogLoads = [loadAgents, loadTeams, loadModels];

  return {
    refresh: guarded<
      | GlobalStorageFs
      | LanguageModel
      | SupabaseAuth
      | FileSystem.FileSystem
      | AgentDirectories
    >(...catalogLoads, loadFiles, loadCommits, loadAuth, loadHostBanners),
    refreshCatalogs: guarded<
      GlobalStorageFs | LanguageModel | FileSystem.FileSystem | AgentDirectories
    >(...catalogLoads),
    refreshFiles: guarded(loadFiles),
    refreshCommits: guarded(loadCommits),
    refreshAuth: guarded(loadAuth),
    refreshHostBanners: guarded(loadHostBanners),
    refreshWorkspaceRoots: () => publish,
    setRecording: (next) =>
      Effect.sync(() => {
        recording = next;
      }).pipe(Effect.andThen(publish)),
    showAgentConfigBanner: (agentName, sessionType) =>
      Effect.sync(() => {
        agentConfig = {
          visible: true,
          agentName,
          sessionType,
          customDirSet: true,
        };
      }).pipe(Effect.andThen(publish)),
    dismissBanner(banner) {
      // The non-login banners are this process's own record, so `dismissed`
      // takes them before `publish` hands the snapshot out. The login
      // dismissal is the one write that outlives the session, and it goes
      // back to the caller to run: its refusal is that request's failure
      // rather than a rejection nobody reads.
      if (banner !== 'login')
        return Effect.sync(() => {
          dismissed.add(banner);
        }).pipe(Effect.andThen(publish));
      // Change the published view only after its durable dismissal commits.
      return Effect.gen(function* () {
        yield* options.stores.globalState.update(
          GlobalStateKey.LOGIN_BANNER_DISMISSED,
          true,
        );
        loginBannerDismissed = true;
        yield* publish;
      });
    },
    setOnboarding: (state) =>
      Effect.suspend(() => {
        if (state === onboarding) return Effect.void;
        onboarding = state;
        return publish;
      }),
  };
}
