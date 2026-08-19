/**
 * Git + integrations handlers: UPDATE_GIT_AUTHOR_SETTINGS,
 * UPDATE_GITHUB_TOKEN_STATUS, UPDATE_CHATGPT_AUTH_STATUS,
 * UPDATE_GROK_AUTH_STATUS, UPDATE_PR_SUBSCRIPTIONS.
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  applySettingsSnapshot,
  chatgptAuth,
  githubTokenStatus,
  gitSettingsLoaded,
  grokAuth,
  prSubscriptions,
} from '../settingsState';

export const gitHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS]: (data) => {
    applySettingsSnapshot(data.values);
    gitSettingsLoaded.set(true);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS]: (data) => {
    githubTokenStatus.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS]: (data) => {
    chatgptAuth.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS]: (data) => {
    grokAuth.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS]: (data) => {
    prSubscriptions.set(data.subscriptions);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
