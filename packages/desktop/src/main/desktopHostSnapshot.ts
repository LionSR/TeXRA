// The `host` snapshot of one paper (PRD one-fold-three-renderers, 8.1): what
// the shell renders but does not own. It rides on every frame that follows a
// change and on every subscribe, so a surface never asks for a catalog and
// never holds a stale one. Every producer is a read the host already owns;
// nothing here is a fact about a run (`SessionView`) or a choice of the
// user's (`Surface`).

import { computeAgentOptionsData } from '@agent/index';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import {
  computeModelOptionsData,
  getEnabledModels,
} from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import { FILE_SELECT_CONFIGS } from '@shared/launcher/fileSelectConfigs';
import type { HostSnapshot, PaperDisplay } from '@shared/session/hostSnapshot';

import type { DesktopFileSelection } from './desktopFileSelection.js';

interface DesktopHostSnapshotOptions {
  paper: PaperDisplay;
  globalState: StateStore;
  files: DesktopFileSelection;
  readRecentCommits(): Promise<{ commits: string[]; isGitRepo: boolean }>;
  /** Whether the user is signed in; the login banner is its negation. */
  isAuthenticated(): Promise<boolean>;
  onError(error: unknown): void;
}

type Banners = HostSnapshot['banners'];

export interface DesktopHostSnapshotSource {
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

/** The paper's display record and the catalogs, assembled per paper. */
export function createDesktopHostSnapshot(
  options: DesktopHostSnapshotOptions,
): DesktopHostSnapshotSource {
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
  let fileOptions: HostSnapshot['fileOptions'] = {
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
  let recording: HostSnapshot['recording'] = null;
  let agentConfig: Banners['agentConfig'] = { visible: false };
  let onboarding: HostSnapshot['onboarding'] = 'done';
  const dismissed = new Set<'login' | 'gettingStarted' | 'dependency'>();

  function publish(): void {
    snapshot = {
      paper: options.paper,
      placement: 'desktop',
      ...catalogs,
      // The desktop shows one paper per window: the launcher's root picker
      // has exactly that root to offer.
      workspaceRoots: [],
      fileConfigs: [...FILE_SELECT_CONFIGS],
      fileOptions: { ...fileOptions, commit: ['HEAD', ...commits.commits] },
      isGitRepo: commits.isGitRepo,
      recording,
      debugMode: false,
      banners: {
        // Keys live in Settings on the desktop; the dependency check is
        // the Tools tab's.
        apiKey: { visible: false },
        agentConfig,
        dependency: { visible: false },
        gettingStarted: !hasInputFiles && !dismissed.has('gettingStarted'),
        login: !authenticated && !dismissed.has('login'),
      },
      onboarding,
    };
    for (const listener of [...listeners]) listener(snapshot);
  }

  async function loadCatalogs(): Promise<void> {
    const [agentOptions, teamOptions, modelOptions] = await Promise.all([
      computeAgentOptionsData(),
      loadTeamOptions(createTeamCatalogPorts()),
      computeModelOptionsData(getEnabledModels(options.globalState)),
    ]);
    catalogs = { agentOptions, teamOptions, modelOptions };
  }

  async function loadFiles(): Promise<void> {
    fileOptions = await options.files.fileOptions();
    hasInputFiles = fileOptions.baseFile.length > 0;
  }

  async function loadCommits(): Promise<void> {
    commits = await options.readRecentCommits();
  }

  async function loadAuth(): Promise<void> {
    authenticated = await options.isAuthenticated();
  }

  const guarded = (load: () => Promise<void>) => async (): Promise<void> => {
    try {
      await load();
    } catch (error) {
      options.onError(error);
      return;
    }
    publish();
  };

  return {
    current: () => snapshot,
    refresh: guarded(async () => {
      await Promise.all([
        loadCatalogs(),
        loadFiles(),
        loadCommits(),
        loadAuth(),
      ]);
    }),
    refreshCatalogs: guarded(loadCatalogs),
    refreshFiles: guarded(loadFiles),
    refreshCommits: guarded(loadCommits),
    refreshAuth: guarded(loadAuth),
    setRecording(next) {
      recording = next;
      publish();
    },
    setAgentConfigBanner(banner) {
      agentConfig = banner;
      publish();
    },
    dismissBanner(banner) {
      dismissed.add(banner);
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
