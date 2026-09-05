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
import { computeAgentOptionsData } from '@agent/index';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import {
  computeModelOptionsData,
  getEnabledModels,
} from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import type { FileOptions } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FILE_SELECT_CONFIGS } from '@shared/launcher/fileSelectConfigs';
import type { HostSnapshot, PaperDisplay } from '@shared/session/hostSnapshot';

type Banners = HostSnapshot['banners'];

export interface HostSnapshotSourceOptions {
  paper: PaperDisplay;
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
  onError(error: unknown): void;
}

export interface HostSnapshotSource {
  /** The snapshot as last assembled; null until the first `refresh`. */
  current(): HostSnapshot | null;
  /** Reassemble every catalog and publish the result. */
  refresh(): Promise<void>;
  /** The agent, team, and model catalogs changed (a roster edit, a
   *  credential, a sign-in). */
  refreshCatalogs(): Promise<void>;
  /** The paper's files changed on disk, or the surface asked for a relist. */
  refreshFiles(): Promise<void>;
  refreshCommits(): Promise<void>;
  /** The sign-in state changed. */
  refreshAuth(): Promise<void>;
  /** The host's own banners changed (a key stored, a tool installed). */
  refreshHostBanners(): Promise<void>;
  /** The workspace folders changed. */
  refreshWorkspaceRoots(): void;
  /** The one recorder per process started or stopped. */
  setRecording(recording: HostSnapshot['recording']): void;
  /** The agent-config notice: a run loaded an agent from the custom
   *  directory, or the user dismissed the notice. */
  setAgentConfigBanner(banner: Banners['agentConfig']): void;
  /** The user dismissed one of the dismissable banners. */
  dismissBanner(banner: 'login' | 'gettingStarted' | 'dependency'): void;
  setOnboarding(state: HostSnapshot['onboarding']): void;
  /** Fires with every published snapshot. */
  onChange(listener: (snapshot: HostSnapshot) => void): () => void;
}

/** The paper's display record and the catalogs, assembled per session. */
export function createHostSnapshotSource(
  options: HostSnapshotSourceOptions,
): HostSnapshotSource {
  const listeners = new Set<(snapshot: HostSnapshot) => void>();
  let snapshot: HostSnapshot | null = null;
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
    snapshot = {
      paper: options.paper,
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
    };
    for (const listener of [...listeners]) listener(snapshot);
  }

  async function loadAgents(): Promise<void> {
    catalogs = { ...catalogs, agentOptions: await computeAgentOptionsData() };
  }

  async function loadTeams(): Promise<void> {
    catalogs = {
      ...catalogs,
      teamOptions: await loadTeamOptions(createTeamCatalogPorts()),
    };
  }

  async function loadModels(): Promise<void> {
    catalogs = {
      ...catalogs,
      modelOptions: await computeModelOptionsData(
        getEnabledModels(options.globalState),
      ),
    };
  }

  async function loadFiles(): Promise<void> {
    fileOptions = await options.fileOptions();
    hasInputFiles = fileOptions.baseFile.length > 0;
  }

  async function loadCommits(): Promise<void> {
    commits = await options.readRecentCommits();
  }

  async function loadAuth(): Promise<void> {
    authenticated = await options.isAuthenticated();
  }

  async function loadHostBanners(): Promise<void> {
    const [key, tools] = await Promise.all([
      options.apiKeyBanner?.(),
      options.dependencyBanner?.(),
    ]);
    if (key) apiKey = key;
    if (tools) dependency = tools;
  }

  /** Each producer settles on its own: one that fails is reported and keeps
   *  its last value, and the snapshot still publishes what the others read,
   *  so a single unavailable source never leaves the shell blank. */
  const guarded =
    (...loads: (() => Promise<void>)[]) =>
    async (): Promise<void> => {
      const settled = await Promise.allSettled(loads.map((load) => load()));
      for (const result of settled) {
        if (result.status === 'rejected') options.onError(result.reason);
      }
      publish();
    };

  const catalogLoads = [loadAgents, loadTeams, loadModels];

  return {
    current: () => snapshot,
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
    setAgentConfigBanner(banner) {
      agentConfig = banner;
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
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
