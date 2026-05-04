import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { AGENT_CATEGORY, type AgentCategory } from '@shared/schemas/agent';
import {
  SwitchViewMessageSchema,
  type SwitchViewTarget,
} from '@shared/schemas/commonViewMessages';
import {
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';
import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopRoute,
} from '../desktopShellMessages.js';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';

export interface DesktopShellIpcOptions {
  getCustomAgentDirectory?: () => Promise<string>;
  openPath?: (filePath: string) => Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

const SWITCH_VIEW_ROUTES = {
  main: 'main',
  progress: 'progress',
  dashboard: 'settings',
} satisfies Record<SwitchViewTarget, DesktopRoute>;

function getAgentSettingsSubTab(message: DesktopCommandMessage) {
  return message.sessionType === AGENT_CATEGORY.TOOL_USE
    ? AGENT_CATEGORY.TOOL_USE
    : undefined;
}

export function createDesktopShellIpc(
  renderer: DesktopRenderer,
  options: DesktopShellIpcOptions = {},
): DesktopMessageHandler {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  function postRoute(route: DesktopRoute) {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route,
    });
  }

  function postSettingsRoute(
    tabIndex?: SettingsTab,
    agentSubTab?: AgentCategory,
  ) {
    postRoute('settings');
    if (tabIndex == null) return;
    renderer.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex,
      ...(agentSubTab && { agentSubTab }),
    });
  }

  function postRouteForSwitchView(message: DesktopCommandMessage) {
    const result = SwitchViewMessageSchema.safeParse(message);
    if (!result.success) return;
    postRoute(SWITCH_VIEW_ROUTES[result.data.view]);
  }

  async function openCustomAgentDirectory() {
    if (!options.getCustomAgentDirectory || !options.openPath) {
      postSettingsRoute(SETTINGS_TAB.AGENTS);
      return;
    }
    const customDir = await options.getCustomAgentDirectory();
    await options.openPath(customDir);
  }

  function handleOpenAgentDirectory(message: DesktopCommandMessage) {
    if (message.customDirSet !== true) {
      postSettingsRoute(SETTINGS_TAB.AGENTS);
      return;
    }
    void openCustomAgentDirectory().catch(reportAsyncError);
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case COMMON_COMMANDS.SWITCH_VIEW:
          postRouteForSwitchView(message);
          return true;
        case MAIN_VIEW_COMMANDS.SETTINGS_OPEN:
          postSettingsRoute();
          return true;
        case MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS:
          postSettingsRoute(
            SETTINGS_TAB.AGENTS,
            getAgentSettingsSubTab(message),
          );
          return true;
        case MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS:
          postSettingsRoute(SETTINGS_TAB.MODELS);
          return true;
        case MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS:
          postSettingsRoute(SETTINGS_TAB.MULTI_AGENT);
          return true;
        case MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY:
          handleOpenAgentDirectory(message);
          return true;
        case MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS:
          renderer.postToRenderer({
            command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
            commits: [],
            isGitRepo: false,
          });
          return true;
        default:
          return false;
      }
    },
  };
}
