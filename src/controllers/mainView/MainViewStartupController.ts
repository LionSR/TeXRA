// Local imports - platform
import type { StateStore } from '@platform/interfaces';

// Local imports - common
import type {
  AgentOptionData,
  MainViewMessage,
  ModelOptionData,
  TeamOptionData,
} from '@shared/schemas';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';

/**
 * Login-banner input for the main view. Only the authenticated flag is
 * consumed, so hosts deliberately avoid the profile and tier round-trips that
 * the settings-view profile message makes.
 */
export interface MainViewAuthStatus {
  authenticated: boolean;
}

export interface MainViewStartupOptions {
  modelOptionsByCategory: {
    workflow: ModelOptionData[];
    toolUse: ModelOptionData[];
  };
  agentOptions: {
    workflow?: AgentOptionData[];
    toolUse?: AgentOptionData[];
  };
  teamOptions: TeamOptionData[];
}

export interface MainViewStartupControllerDeps {
  loadOptions(): Promise<MainViewStartupOptions>;
  getAuthStatus(): Promise<MainViewAuthStatus>;
  globalState: StateStore;
}

type MainViewStartupMessage = Extract<
  MainViewMessage,
  | { command: typeof MAIN_VIEW_COMMANDS.SET_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS }
>;

export class MainViewStartupController {
  constructor(private readonly deps: MainViewStartupControllerDeps) {}

  /**
   * Banner dismissals live in global state and are written only by the
   * banner's own close button.
   */
  private isBannerDismissed(key: GlobalStateKey): boolean {
    return this.deps.globalState.get<boolean>(key) === true;
  }

  getOrchestratorBannerMessage(): MainViewStartupMessage {
    const dismissed = this.isBannerDismissed(
      GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED,
    );
    return {
      command: MAIN_VIEW_COMMANDS.SET_BANNER,
      banner: 'orchestrator',
      visible: !dismissed,
    };
  }

  async getOptionsAndLoginMessages(): Promise<MainViewStartupMessage[]> {
    const [{ modelOptionsByCategory, agentOptions, teamOptions }, authStatus] =
      await Promise.all([this.deps.loadOptions(), this.deps.getAuthStatus()]);

    const showLoginBanner =
      !authStatus.authenticated &&
      !this.isBannerDismissed(GlobalStateKey.LOGIN_BANNER_DISMISSED);

    return [
      {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsDataByCategory: modelOptionsByCategory,
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: agentOptions,
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
        optionsData: teamOptions,
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_BANNER,
        banner: 'login',
        visible: showLoginBanner,
      },
    ];
  }
}
