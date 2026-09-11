/**
 * The `host` snapshot of one session (PRD one-fold-three-renderers, 8.1):
 * what the shell renders but does not own. It rides on every frame that
 * follows a change and on every subscribe, so a surface never asks for a
 * catalog and never holds a stale one. Every producer is a read the host
 * already owns; nothing here is a fact about a run (`SessionView`) or a
 * choice of the user's (`Surface`). The catalogs are host-neutral; the
 * host injects its file lists, its git probe, its sign-in probe, and the
 * banners only it can answer (a VS Code host knows its API-key status and
 * its missing tools; the desktop keeps both in Settings).
 */
import { Cause, Effect, Exit } from 'effect';
import { computeAgentOptionsData } from '@agent/index';
import { hostPort } from '@common/hostPort';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import {
  computeModelOptionsData,
  getEnabledModels,
} from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import type { FileOptions, SessionType } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FILE_SELECT_CONFIGS } from '@shared/launcher/fileSelectConfigs';
import type {
  HostSnapshot,
  ProjectDisplay,
} from '@shared/session/hostSnapshot';

type Banners = HostSnapshot['banners'];

interface HostSnapshotSourceOptions {
  project: ProjectDisplay;
  globalState: StateStore;
  /** The launcher's single-slot catalogs: base and edited candidates. */
  fileOptions(): Promise<FileOptions>;
  readRecentCommits(): Promise<{ commits: string[]; isGitRepo: boolean }>;
  /** Whether the user is signed in; the login banner is its negation. */
  isAuthenticated(): Promise<boolean>;
  /** The launcher's root picker; empty where a session has exactly one. */
  workspaceRoots?: () => HostSnapshot['workspaceRoots'];
  debugMode?: () => boolean;
  /** Hosts that surface these outside Settings answer them; absent means
   *  never shown. */
  apiKeyBanner?: () => Promise<Banners['apiKey']>;
  dependencyBanner?: () => Promise<Banners['dependency']>;
  /** Write directly to the bridge's host snapshot, which its runs replay. */
  publish(snapshot: HostSnapshot): void;
  onError(error: unknown): void;
}

export interface HostSnapshotSource {
  /** Reassemble every catalog and publish the result. */
  readonly refresh: Effect.Effect<void>;
  /** The agent, team, and model catalogs changed (a roster edit, a
   *  credential, a sign-in). */
  readonly refreshCatalogs: Effect.Effect<void>;
  /** The project's files changed on disk, or the surface asked for a relist. */
  readonly refreshFiles: Effect.Effect<void>;
  readonly refreshCommits: Effect.Effect<void>;
  /** The sign-in state changed. */
  readonly refreshAuth: Effect.Effect<void>;
  /** The host's own banners changed (a key stored, a tool installed). */
  readonly refreshHostBanners: Effect.Effect<void>;
  /** The workspace folders changed. */
  refreshWorkspaceRoots(): void;
  /** The one recorder per process started or stopped. */
  setRecording(recording: HostSnapshot['recording']): void;
  /** A run loaded an agent from the custom directory, under the category
   *  it was launched as: the banner's actions edit that catalog. */
  showAgentConfigBanner(agentName: string, sessionType: SessionType): void;
  /** The user dismissed one of the dismissable banners. */
  dismissBanner(banner: 'login' | 'gettingStarted' | 'dependency'): void;
  setOnboarding(state: HostSnapshot['onboarding']): void;
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
  let apiKey: Banners['apiKey'] = { visible: false };
  let dependency: Banners['dependency'] = { visible: false };
  let recording: HostSnapshot['recording'] = null;
  let agentConfig: Banners['agentConfig'] = { visible: false };
  let onboarding: HostSnapshot['onboarding'] = 'done';
  // The login banner's dismissal is the host's persisted record; the other
  // two last a session.
  const dismissed = new Set<'gettingStarted' | 'dependency'>();

  function publish(): void {
    options.publish({
      project: options.project,
      ...catalogs,
      workspaceRoots: options.workspaceRoots?.() ?? [],
      fileConfigs: [...FILE_SELECT_CONFIGS],
      fileOptions: { ...fileOptions, commit: ['HEAD', ...commits.commits] },
      isGitRepo: commits.isGitRepo,
      recording,
      debugMode: options.debugMode?.() ?? false,
      banners: {
        apiKey,
        agentConfig,
        dependency: {
          ...dependency,
          visible: dependency.visible && !dismissed.has('dependency'),
        },
        gettingStarted: !hasInputFiles && !dismissed.has('gettingStarted'),
        login:
          !authenticated &&
          !options.globalState.get<boolean>(
            GlobalStateKey.LOGIN_BANNER_DISMISSED,
            false,
          ),
      },
      onboarding,
    });
  }

  const loadAgents = Effect.gen(function* () {
    catalogs = { ...catalogs, agentOptions: yield* computeAgentOptionsData() };
  });

  const loadTeams = Effect.gen(function* () {
    catalogs = {
      ...catalogs,
      teamOptions: yield* loadTeamOptions(createTeamCatalogPorts()),
    };
  });

  const loadModels = Effect.gen(function* () {
    catalogs = {
      ...catalogs,
      modelOptions: yield* hostPort(() =>
        computeModelOptionsData(getEnabledModels(options.globalState)),
      ),
    };
  });

  const loadFiles = Effect.gen(function* () {
    fileOptions = yield* hostPort(() => options.fileOptions());
    hasInputFiles = fileOptions.baseFile.length > 0;
  });

  const loadCommits = Effect.gen(function* () {
    commits = yield* hostPort(() => options.readRecentCommits());
  });

  const loadAuth = Effect.gen(function* () {
    authenticated = yield* hostPort(() => options.isAuthenticated());
  });

  const loadHostBanners = Effect.gen(function* () {
    const [key, tools] = yield* Effect.all(
      [
        options.apiKeyBanner
          ? hostPort(() => options.apiKeyBanner!())
          : Effect.succeed(undefined),
        options.dependencyBanner
          ? hostPort(() => options.dependencyBanner!())
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
  const guarded = (
    ...loads: Effect.Effect<void, unknown>[]
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const settled = yield* Effect.forEach(
        loads,
        (load) => Effect.exit(load),
        { concurrency: 'unbounded' },
      );
      for (const exit of settled) {
        if (Exit.isFailure(exit)) options.onError(Cause.squash(exit.cause));
      }
      publish();
    });

  const catalogLoads = [loadAgents, loadTeams, loadModels];

  return {
    refresh: guarded(
      ...catalogLoads,
      loadFiles,
      loadCommits,
      loadAuth,
      loadHostBanners,
    ),
    refreshCatalogs: guarded(...catalogLoads),
    refreshFiles: guarded(loadFiles),
    refreshCommits: guarded(loadCommits),
    refreshAuth: guarded(loadAuth),
    refreshHostBanners: guarded(loadHostBanners),
    refreshWorkspaceRoots: publish,
    setRecording(next) {
      recording = next;
      publish();
    },
    showAgentConfigBanner(agentName, sessionType) {
      agentConfig = {
        visible: true,
        agentName,
        sessionType,
        customDirSet: true,
      };
      publish();
    },
    dismissBanner(banner) {
      if (banner === 'login') {
        void options.globalState
          .update(GlobalStateKey.LOGIN_BANNER_DISMISSED, true)
          .then(undefined, options.onError);
      } else {
        dismissed.add(banner);
      }
      publish();
    },
    setOnboarding(state) {
      if (state === onboarding) return;
      onboarding = state;
      publish();
    },
  };
}
