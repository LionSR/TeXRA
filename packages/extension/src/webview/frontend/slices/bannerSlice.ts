/**
 * Banner slice: API-key, agent-config, dependency, and login banner pushes.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewHandlerRegistry } from '@shared/schemas';

// Local imports - main view
import {
  agentConfigBanner$,
  apiKeyBanner$,
  dependencyBanner$,
  getModelOptionsForSession,
  loginBannerVisible$,
  model$,
  sessionType$,
} from '../mainViewState';

function shouldForceApiKeyBanner(): boolean {
  if (apiKeyBanner$.get().requiresKey) {
    return true;
  }
  const option = getModelOptionsForSession(sessionType$.get()).find(
    (item) => item.value === model$.get(),
  );
  return option?.requiresKey ?? false;
}

export const bannerHandlers: MainViewHandlerRegistry = {
  [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (message) => {
    apiKeyBanner$.set({
      visible: true,
      provider: message.provider ?? '',
      requiresKey: message.requiresKey ?? false,
    });
  },
  [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: () => {
    if (shouldForceApiKeyBanner()) {
      return;
    }
    apiKeyBanner$.set({ visible: false });
  },

  [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: (message) => {
    agentConfigBanner$.set({
      visible: true,
      agentName: message.agentName ?? '',
      customDirSet: message.customDirSet ?? false,
    });
  },
  [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: () => {
    agentConfigBanner$.set({ visible: false });
  },

  [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: (message) => {
    dependencyBanner$.set({
      visible: true,
      missingTools: message.missingTools ?? [],
    });
  },
  [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: () => {
    dependencyBanner$.set({ visible: false });
  },

  [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: () => {
    loginBannerVisible$.set(true);
  },
  [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: () => {
    loginBannerVisible$.set(false);
  },
};
