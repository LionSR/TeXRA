// Local imports - common
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import type {
  AgentOptionData,
  MainViewMessage,
  ModelOptionData,
} from '@shared/schemas';

export interface MainViewStartupOptions {
  modelOptions: ModelOptionData[];
  agentOptions: {
    workflow?: AgentOptionData[];
    toolUse?: AgentOptionData[];
  };
}

export interface MainViewAuthStatus {
  authenticated: boolean;
}

export interface MainViewStartupControllerDeps {
  getConfig<T>(key: string, defaultValue: T): T;
  loadOptions(): Promise<MainViewStartupOptions>;
  getAuthStatus(): Promise<MainViewAuthStatus>;
}

type MainViewStartupMessage = Extract<
  MainViewMessage,
  | { command: typeof MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS }
  | { command: typeof MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS }
  | { command: typeof MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER }
>;

export class MainViewStartupController {
  constructor(private readonly deps: MainViewStartupControllerDeps) {}

  getOrchestratorBannerMessage(): MainViewStartupMessage {
    const showOrchestratorBanner = this.deps.getConfig<boolean>(
      'ui.showOrchestratorBanner',
      true,
    );
    return {
      command: showOrchestratorBanner
        ? MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER
        : MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER,
    };
  }

  async getOptionsAndLoginMessages(): Promise<MainViewStartupMessage[]> {
    const [{ modelOptions, agentOptions }, authStatus] = await Promise.all([
      this.deps.loadOptions(),
      this.deps.getAuthStatus(),
    ]);

    const showLoginBanner =
      !authStatus.authenticated &&
      this.deps.getConfig<boolean>('ui.showLoginBanner', true);

    return [
      {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsData: modelOptions,
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: agentOptions,
      },
      {
        command: showLoginBanner
          ? MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
      },
    ];
  }
}
