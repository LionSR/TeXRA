// Local imports - schemas
import type { MainViewInboundMessage, MainViewMessage } from '@shared/schemas';

// Local imports - IPC contracts
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';

export interface MainViewCommandPlan {
  command: string;
  args: unknown[];
}

export interface MainViewConfigUpdate {
  key: string;
  value: boolean;
}

export type MainViewAgentDirectoryAction =
  { kind: 'openAgentSettings' } | { kind: 'revealCustomDirectory' };

export interface MainViewInteractionControllerDeps {
  getProviderUrl(provider: string): string | undefined;
  getToolDocsCommand(tool: string): string | undefined;
}

type SwitchViewMessage = Extract<
  MainViewInboundMessage,
  { command: typeof COMMON_COMMANDS.SWITCH_VIEW }
>;

type OpenAgentSettingsMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS }
>;

type OpenAgentDirectoryMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY }
>;

type OpenSetProviderApiKeyMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY }
>;

type OpenProviderApiKeyUrlMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL }
>;

type OpenInstallGuideMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE }
>;

type DismissBannerMessage = Extract<
  MainViewInboundMessage,
  | { command: typeof MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER }
>;

type DependencyBannerMessage = Extract<
  MainViewMessage,
  | { command: typeof MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER }
  | { command: typeof MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER }
>;

const API_KEY_GUIDE_URL =
  'https://texra.ai/guide/installation#setting-up-api-keys';

const DISMISS_CONFIG_KEYS: Record<DismissBannerMessage['command'], string> = {
  [MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER]: 'ui.showLoginBanner',
  [MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER]: 'ui.showOrchestratorBanner',
};

export class MainViewInteractionController {
  constructor(private readonly deps: MainViewInteractionControllerDeps) {}

  getSwitchViewCommand(message: SwitchViewMessage): MainViewCommandPlan {
    if (message.view === 'dashboard') {
      return { command: 'texra.showDashboard', args: [] };
    }
    if (message.view === 'main') {
      return { command: 'texra.showMainView', args: [] };
    }
    if (message.openInEditor) {
      return { command: 'texra.openProgressViewInTab', args: [] };
    }
    return {
      command: 'texra.showProgressView',
      args: [{ inPlace: true }],
    };
  }

  getOpenSettingsCommand(settingsQuery: string): MainViewCommandPlan {
    return {
      command: 'workbench.action.openSettings',
      args: [settingsQuery],
    };
  }

  getOpenAgentSettingsCommand(
    message: OpenAgentSettingsMessage,
  ): MainViewCommandPlan {
    return {
      command: 'texra.showAgents',
      args: [message.sessionType === 'toolUse' ? 'toolUse' : undefined],
    };
  }

  getAgentDirectoryAction(
    message: OpenAgentDirectoryMessage,
  ): MainViewAgentDirectoryAction {
    return message.customDirSet
      ? { kind: 'revealCustomDirectory' }
      : { kind: 'openAgentSettings' };
  }

  getSetProviderApiKeyCommand(
    message: OpenSetProviderApiKeyMessage,
  ): MainViewCommandPlan | null {
    if (!message.provider) return null;
    return { command: 'texra.setApiKey', args: [message.provider] };
  }

  getProviderApiKeyUrl(
    message: OpenProviderApiKeyUrlMessage,
  ): string | undefined {
    return message.provider
      ? this.deps.getProviderUrl(message.provider)
      : undefined;
  }

  getApiKeyGuideUrl(): string {
    return API_KEY_GUIDE_URL;
  }

  getInstallGuideCommand(
    message: OpenInstallGuideMessage,
  ): MainViewCommandPlan | null {
    const docsCommand = this.deps.getToolDocsCommand(message.tool);
    if (!docsCommand) return null;

    const [command, ...args] = docsCommand.split(',');
    return { command, args };
  }

  getDependencyBannerMessage(
    missingTools: readonly string[],
  ): DependencyBannerMessage {
    if (missingTools.length === 0) {
      return { command: MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER };
    }
    return {
      command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
      missingTools: [...missingTools],
    };
  }

  getDismissConfigUpdate(message: DismissBannerMessage): MainViewConfigUpdate {
    return {
      key: DISMISS_CONFIG_KEYS[message.command],
      value: false,
    };
  }
}
