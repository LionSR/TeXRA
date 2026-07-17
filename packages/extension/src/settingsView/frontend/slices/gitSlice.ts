/**
 * Git + integrations handlers: UPDATE_GIT_AUTHOR_SETTINGS,
 * UPDATE_GITHUB_TOKEN_STATUS, UPDATE_CHATGPT_AUTH_STATUS,
 * UPDATE_DESKTOP_CRASH_REPORTING, UPDATE_PR_SUBSCRIPTIONS.
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  chatgptAuth,
  kimiCodeAuth,
  desktopCrashReportingConfigured,
  desktopCrashReportingEnabled,
  gitAuthorEmail,
  gitAuthorName,
  githubTokenStatus,
  gitMarkCommits,
  gitSettingsLoaded,
  gitWorktreeSupport,
  prSubscriptions,
} from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns git/integrations
// commands, so it's typed as a `satisfies Partial<...>` subset rather than
// the full registry; `messageDispatcher.ts` spreads all slices together and
// is the actual exhaustiveness checkpoint TypeScript enforces.
export const gitHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS]: (data) => {
    gitMarkCommits.set(data.markCommits);
    gitAuthorName.set(data.authorName);
    gitAuthorEmail.set(data.authorEmail);
    gitWorktreeSupport.set(data.worktreeSupport);
    gitSettingsLoaded.set(true);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS]: (data) => {
    githubTokenStatus.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS]: (data) => {
    chatgptAuth.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_KIMI_CODE_AUTH_STATUS]: (data) => {
    kimiCodeAuth.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING]: (data) => {
    desktopCrashReportingEnabled.set(data.enabled);
    desktopCrashReportingConfigured.set(data.configured);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS]: (data) => {
    prSubscriptions.set(data.subscriptions);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
