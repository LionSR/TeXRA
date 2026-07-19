// Desktop imports
import { createModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionControllerFactory';
import type { DesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import type { DesktopCrashReportingSettingsController } from '@desktop/main/desktopCrashReportingSettingsController';
import type { DesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import type {
  DesktopHistoryOptions,
  DesktopHistorySettingsController,
} from '@desktop/main/desktopHistoryHandlers';
import type { DesktopSettingsUiHost } from '@desktop/main/desktopSettingsIpc';
import type { DesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { unsupported } from '@shared/utils/dispatcher';
import type { SettingsStatePorts } from '@shared/settingsView/types';

// Shared imports - settings controllers

// Shared imports

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

const noOp = async (): Promise<void> => undefined;

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
    revealStream: noOp,
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
      create: unsupported(
        'Creating custom agents is not available in the desktop app yet.',
      ),
      customize: unsupported(
        'Customizing agents is not available in the desktop app yet.',
      ),
      deleteCustom: unsupported(
        'Deleting custom agents is not available in the desktop app yet.',
      ),
      revealFile: noOp,
      viewRemotePrompt: unsupported(
        'Viewing a remote agent prompt is not available in the desktop app yet.',
      ),
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

export function createStubDesktopCrashReportingSettingsController(
  overrides: Partial<DesktopCrashReportingSettingsController> = {},
): DesktopCrashReportingSettingsController {
  return {
    actions: {
      get: noOp,
      setEnabled: noOp,
      setDsn: noOp,
    },
    postStartupData: noOp,
    ...overrides,
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
      setSubscriptionToolUseOnly: noOp,
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
      installExtension: noOp,
      recheckStatus: noOp,
      toggle: noOp,
      runCommand: noOp,
    },
    latexActions: {
      applySettings: noOp,
      installLatexWorkshop: noOp,
      runInstallCommand: noOp,
      setConfigValue: noOp,
    },
    postLatexConfigValues: () => undefined,
    postStartupData: noOp,
    ...overrides,
  };
}
