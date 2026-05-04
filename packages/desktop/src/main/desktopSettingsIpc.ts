import { platform } from '@platform/platform';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import type { LatexConfigField } from '@shared/constants/latex';
import { SettingsViewInboundMessageSchema } from '@shared/schemas/settingsViewMessages';
import {
  applyGitAuthorSettings,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';
import type { StateStore } from '@platform/interfaces/state';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

export interface DesktopSettingsIpcOptions {
  postToRenderer(message: unknown): void;
  workspaceState?: StateStore;
  onError?: (error: unknown) => void;
}

export type DesktopSettingsIpc = DesktopMessageHandler;

export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): DesktopSettingsIpc {
  const workspaceState = options.workspaceState ?? platform().workspaceState;
  const onError =
    options.onError ??
    ((error) => {
      console.error(error);
    });
  const latexConfigPersistenceController =
    new LatexConfigPersistenceController();

  function readCurrentGitAuthorSettings() {
    return readGitAuthorSettingsFromState(workspaceState);
  }

  function applyCurrentGitAuthorSettings() {
    return applyGitAuthorSettings(readCurrentGitAuthorSettings());
  }

  function postGitAuthorSettings(
    settings = readCurrentGitAuthorSettings(),
  ): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      ...settings,
    });
  }

  function applyAndPostGitAuthorSettings(): void {
    postGitAuthorSettings(applyCurrentGitAuthorSettings());
  }

  function readLatexConfigValues() {
    return latexConfigPersistenceController.buildConfigValues((key) =>
      workspaceState.get(key),
    );
  }

  function postLatexConfigValues(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: readLatexConfigValues(),
    });
  }

  async function updateGitAuthorSetting(
    key: WorkspaceStateKey,
    value: unknown,
  ): Promise<void> {
    await workspaceState.update(key, value);
    applyAndPostGitAuthorSettings();
  }

  async function updateLatexConfigValue(input: {
    field: LatexConfigField;
    value: unknown;
  }): Promise<void> {
    const plan = latexConfigPersistenceController.planUpdate(input);
    if (!plan.ok) {
      onError(plan.error);
      return;
    }

    await workspaceState.update(plan.update.key, plan.update.value);
    postLatexConfigValues();
  }

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  applyCurrentGitAuthorSettings();

  return {
    handleMessage(message: DesktopCommandMessage) {
      const result = SettingsViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      switch (result.data.command) {
        case SETTINGS_VIEW_COMMANDS.WEBVIEW_READY:
          if (result.data.view === 'settings') {
            postGitAuthorSettings();
            postLatexConfigValues();
          }
          return false;
        case SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS:
          postGitAuthorSettings();
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_LATEX_CONFIG_VALUES:
          postLatexConfigValues();
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE:
          runAsync(
            updateLatexConfigValue({
              field: result.data.field,
              value: result.data.value,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_MARK_COMMITS,
              result.data.enabled,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_AUTHOR_NAME,
              result.data.name,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_EMAIL:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_AUTHOR_EMAIL,
              result.data.email,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
              result.data.enabled,
            ),
          );
          return true;
        default:
          return false;
      }
    },
  };
}
