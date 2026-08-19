// Local imports
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import type { DesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import type { DesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import type { DesktopSettingsUiHost } from '@desktop/main/desktopSettingsIpc';
import type { DesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { unsupported } from '@shared/utils/dispatcher';
import type { SettingsStatePorts } from '@shared/settingsView/types';

const noOp = async (): Promise<void> => undefined;

/** Reads the `command` discriminant off a message posted to the renderer. */
export function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
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
    handlers: {
      setAgentEnabled: noOp,
      setAllAgentsEnabled: noOp,
      openAgentYaml: noOp,
      openAgentFolder: noOp,
      createAgent: noOp,
      customizeAgent: noOp,
      deleteCustomAgent: noOp,
      revealAgentFile: noOp,
      viewRemoteAgentPrompt: noOp,
      setCustomAgentDir: noOp,
      resetCustomAgentDir: noOp,
      applyAgentModePreset: noOp,
      saveAgentModePreset: noOp,
      deleteAgentModePreset: noOp,
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
    profileHandlers: {
      signIn: noOp,
      signOut: noOp,
      setProviderKey: noOp,
      removeProviderKey: noOp,
      openProviderKeyUrl: noOp,
      setProviderSetting: noOp,
      openExternalUrl: noOp,
    },
    chatGptHandlers: {
      signInChatGpt: noOp,
      signOutChatGpt: noOp,
      setChatGptPreferSubscription: noOp,
    },
    grokHandlers: {
      signInGrok: noOp,
      signOutGrok: noOp,
      setGrokPreferSubscription: noOp,
    },
    modelSelectionController: new SettingsModelSelectionController({
      globalState: state.globalState,
    }),
    postMainModelOptionsData: noOp,
    postProfileData: noOp,
    postStartupData: noOp,
    postSubscriptionUsage: noOp,
    refreshAfterProviderSettingChange: noOp,
    refreshAuthDependentData: noOp,
    signInChatGpt: noOp,
    signInGrok: noOp,
    ...overrides,
  };
}

export function createStubDesktopToolingSettingsController(
  overrides: Partial<DesktopToolingSettingsController> = {},
): DesktopToolingSettingsController {
  return {
    toolHandlers: {
      openToolInstallUrl: noOp,
      installToolExtension: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
      recheckToolStatus: noOp,
      toggleTool: noOp,
      runToolCommand: noOp,
    },
    latexHandlers: {
      applyLatexSettings: unsupported(
        'Desktop cannot apply recommended VS Code settings.',
      ),
      installLatexWorkshop: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
      runInstallCommand: noOp,
    },
    postLatexConfigValues: () => undefined,
    postStartupData: noOp,
    dispose: () => undefined,
    ...overrides,
  };
}
