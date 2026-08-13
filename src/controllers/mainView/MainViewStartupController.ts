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
  getConfig<T>(key: string, defaultValue: T): T;
  loadOptions(): Promise<MainViewStartupOptions>;
  getAuthStatus(): Promise<MainViewAuthStatus>;
  globalState: StateStore;
}

type MainViewStartupMessage = Extract<
  MainViewMessage,
  | { command: typeof MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS }
  | { command: typeof MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER }
>;

export class MainViewStartupController {
  constructor(private readonly deps: MainViewStartupControllerDeps) {}

  /**
   * Banner dismissals live in global state and are written only by the
   * banner's own close button. They were `texra.ui.show*Banner` settings until
   * they moved here, so a pre-move `false` still counts as dismissed; nothing
   * writes the legacy key back.
   */
  private isBannerDismissed(
    key: GlobalStateKey,
    legacySettingPath: string,
  ): boolean {
    if (this.deps.globalState.get<boolean>(key) === true) return true;
    return this.deps.getConfig<boolean>(legacySettingPath, true) === false;
  }

  getOrchestratorBannerMessage(): MainViewStartupMessage {
    const dismissed = this.isBannerDismissed(
      GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED,
      'ui.showOrchestratorBanner',
    );
    return {
      command: dismissed
        ? MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER
        : MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER,
    };
  }

  async getOptionsAndLoginMessages(): Promise<MainViewStartupMessage[]> {
    const [{ modelOptionsByCategory, agentOptions, teamOptions }, authStatus] =
      await Promise.all([this.deps.loadOptions(), this.deps.getAuthStatus()]);

    const showLoginBanner =
      !authStatus.authenticated &&
      !this.isBannerDismissed(
        GlobalStateKey.LOGIN_BANNER_DISMISSED,
        'ui.showLoginBanner',
      );

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
        command: showLoginBanner
          ? MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
      },
    ];
  }
}
