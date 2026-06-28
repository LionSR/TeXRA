// Local imports - common
import type {
  AgentOptionData,
  MainViewMessage,
  ModelOptionData,
} from '@shared/schemas';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';

// Local imports - controllers
import type { MainViewAuthStatus } from './MainViewTypes';

export interface MainViewStartupOptions {
  modelOptions: ModelOptionData[];
  agentOptions: {
    workflow?: AgentOptionData[];
    toolUse?: AgentOptionData[];
  };
}

export interface MainViewStartupControllerDeps {
  getConfig<T>(key: string, defaultValue: T): T;
  loadOptions?: () => Promise<MainViewStartupOptions>;
  loadModelOptions?: () => Promise<ModelOptionData[]>;
  loadAgentOptions?: () => Promise<MainViewStartupOptions['agentOptions']>;
  refreshAgentCatalog?: () => Promise<void>;
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
    const [options, authStatus] = await Promise.all([
      this.loadOptionsWithFreshAgentCatalog(),
      this.deps.getAuthStatus(),
    ]);

    const showLoginBanner =
      !authStatus.authenticated &&
      this.deps.getConfig<boolean>('ui.showLoginBanner', true);

    return [
      this.getModelOptionsMessage(options.modelOptions),
      this.getAgentOptionsMessage(options.agentOptions),
      {
        command: showLoginBanner
          ? MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
      },
    ];
  }

  async getModelOptionsRefreshMessage(): Promise<MainViewStartupMessage> {
    const modelOptions =
      this.deps.loadModelOptions == null
        ? (await this.loadOptionsSnapshot()).modelOptions
        : await this.deps.loadModelOptions();
    return this.getModelOptionsMessage(modelOptions);
  }

  async getAgentOptionsRefreshMessage(): Promise<MainViewStartupMessage> {
    await this.refreshAgentCatalog();
    const agentOptions =
      this.deps.loadAgentOptions == null
        ? (await this.loadOptionsSnapshot()).agentOptions
        : await this.deps.loadAgentOptions();
    return this.getAgentOptionsMessage(agentOptions);
  }

  async getAllOptionsRefreshMessages(): Promise<MainViewStartupMessage[]> {
    const options = await this.loadOptionsWithFreshAgentCatalog();
    return [
      this.getModelOptionsMessage(options.modelOptions),
      this.getAgentOptionsMessage(options.agentOptions),
    ];
  }

  private async loadOptionsWithFreshAgentCatalog(): Promise<MainViewStartupOptions> {
    await this.refreshAgentCatalog();
    return this.loadOptionsSnapshot();
  }

  private async loadOptionsSnapshot(): Promise<MainViewStartupOptions> {
    if (this.deps.loadOptions != null) {
      return this.deps.loadOptions();
    }
    if (
      this.deps.loadModelOptions == null ||
      this.deps.loadAgentOptions == null
    ) {
      throw new Error(
        'MainViewStartupController requires either loadOptions or both split option loaders.',
      );
    }
    const [modelOptions, agentOptions] = await Promise.all([
      this.deps.loadModelOptions(),
      this.deps.loadAgentOptions(),
    ]);
    return { modelOptions, agentOptions };
  }

  private async refreshAgentCatalog(): Promise<void> {
    await this.deps.refreshAgentCatalog?.();
  }

  private getModelOptionsMessage(
    optionsData: ModelOptionData[],
  ): MainViewStartupMessage {
    return {
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData,
    };
  }

  private getAgentOptionsMessage(
    optionsData: MainViewStartupOptions['agentOptions'],
  ): MainViewStartupMessage {
    return {
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData,
    };
  }
}
