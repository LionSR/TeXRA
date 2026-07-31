// Local imports
import { createModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionControllerFactory';
import type { DesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import type { DesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import type {
  DesktopHistoryOptions,
  DesktopHistorySettingsController,
} from '@desktop/main/desktopHistoryHandlers';
import type { DesktopSettingsUiHost } from '@desktop/main/desktopSettingsIpc';
import type { DesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { unsupported } from '@shared/utils/dispatcher';
import type { SettingsStatePorts } from '@shared/settingsView/types';

// Local file imports
import { repoPath } from './desktopTestPaths.mjs';

const noOp = async (): Promise<void> => undefined;

/** Reads the `command` discriminant off a message posted to the renderer. */
export function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

export function createStubDesktopHistoryOptions(
  overrides: Partial<DesktopHistoryOptions> = {},
): DesktopHistoryOptions {
  return {
    resourcesPath: repoPath('packages', 'extension', 'resources'),
    runExecution: noOp,
    restoreTaskState: async () => true,
    postToRenderer: () => undefined,
    openPath: noOp,
    showInfoMessage: noOp,
    showWarningMessage: noOp,
    showErrorMessage: noOp,
    onError: () => undefined,
    ...overrides,
  };
}

export function createStubDesktopHistorySettingsController(
  overrides: Partial<DesktopHistorySettingsController> = {},
): DesktopHistorySettingsController {
  return {
    actions: {
      deleteAgent: noOp,
      clear: noOp,
      rerunAgent: noOp,
      restoreAgent: noOp,
      exportChatMd: noOp,
      exportChatTex: noOp,
      exportChatHtml: noOp,
    },
    postHistoryData: noOp,
    ...overrides,
  };
}

export function createStubDesktopSettingsUiHost(
  overrides: Partial<DesktopSettingsUiHost> = {},
): DesktopSettingsUiHost {
  return {
    openPath: noOp,
    revealStream: async () => 'revealed',
    getStreamLabel: () => undefined,
    showInfoMessage: noOp,
    showErrorMessage: noOp,
    confirmAction: async () => true,
    onError: () => undefined,
    ...overrides,
  };
}

export function createStubDesktopAgentSettingsController(): DesktopAgentSettingsController {
  return {
    actions: {
      setEnabled: noOp,
      setAllEnabled: noOp,
      openYaml: noOp,
      openFolder: noOp,
      create: noOp,
      customize: noOp,
      deleteCustom: noOp,
      revealFile: noOp,
      viewRemotePrompt: noOp,
      setCustomDir: noOp,
      resetCustomDir: noOp,
      applyModePreset: noOp,
      saveModePreset: noOp,
      deleteModePreset: noOp,
    },
    postStartupData: noOp,
    refreshCatalogData: noOp,
  };
}

export function createStubDesktopCredentialSettingsController(
  state: SettingsStatePorts,
  overrides: Partial<DesktopCredentialSettingsController> = {},
): DesktopCredentialSettingsController {
  return {
    profileActions: {
      signIn: noOp,
      signOut: noOp,
      setApiAccessMode: noOp,
      setProviderKey: noOp,
      removeProviderKey: noOp,
      openProviderKeyUrl: noOp,
      setProviderStreaming: noOp,
      setProviderEndpoint: noOp,
      setGlobalStreaming: noOp,
      setProviderVscodeSetting: unsupported(
        'VS Code provider settings are not applicable in the desktop app.',
      ),
      openExternalUrl: noOp,
    },
    chatGptActions: {
      signIn: noOp,
      signOut: noOp,
      setPreferSubscription: noOp,
    },
    modelSelectionController: createModelSelectionController(state),
    prepareModelSelectionData: noOp,
    postMainModelOptionsData: noOp,
    postStartupData: noOp,
    refreshAuthDependentData: noOp,
    signInChatGpt: noOp,
    ...overrides,
  };
}

export function createStubDesktopToolingSettingsController(
  overrides: Partial<DesktopToolingSettingsController> = {},
): DesktopToolingSettingsController {
  return {
    toolsActions: {
      openInstallUrl: noOp,
      installExtension: unsupported('Desktop cannot host VS Code extensions.'),
      recheckStatus: noOp,
      toggle: noOp,
      runCommand: noOp,
    },
    latexActions: {
      applySettings: noOp,
      installLatexWorkshop: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
      runInstallCommand: noOp,
      setConfigValue: noOp,
    },
    postLatexConfigValues: () => undefined,
    postStartupData: noOp,
    ...overrides,
  };
}
