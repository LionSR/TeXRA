// Local imports
import { Effect } from 'effect';

import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import type { DesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import type { DesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import type { DesktopSettingsUiHost } from '@desktop/main/desktopSettingsIpc';
import type { DesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import { discoveredCopilotRoutes } from '@model/runtimeModelRegistry';
import { unsupported } from '@shared/utils/dispatcher';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

const noOp = async (): Promise<void> => undefined;

const noOpEffect = (): Effect.Effect<void> => Effect.void;

/** Reads the `command` discriminant off a message posted to the renderer. */
export function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

export function createStubDesktopSettingsUiHost(
  overrides: Partial<DesktopSettingsUiHost> = {},
): DesktopSettingsUiHost {
  return {
    openPath: () => Effect.void,
    revealRun: async () => 'revealed',
    getRunLabel: () => undefined,
    promptForSecret: () => Effect.succeed(undefined),
    openExternal: noOp,
    showInfoMessage: () => Effect.void,
    showErrorMessage: () => Effect.void,
    confirmAction: async () => true,
    onError: () => undefined,
    ...overrides,
  };
}

export function createStubDesktopAgentSettingsController(): DesktopAgentSettingsController {
  return {
    handlers: {
      setAgentEnabled: noOpEffect,
      setAllAgentsEnabled: noOpEffect,
      openAgentYaml: noOpEffect,
      openAgentFolder: noOpEffect,
      createAgent: noOpEffect,
      customizeAgent: noOpEffect,
      deleteCustomAgent: noOpEffect,
      revealAgentFile: noOpEffect,
      viewRemoteAgentPrompt: noOpEffect,
      setCustomAgentDir: noOpEffect,
      resetCustomAgentDir: noOpEffect,
      applyAgentModePreset: noOpEffect,
      saveAgentModePreset: noOpEffect,
      deleteAgentModePreset: noOpEffect,
    },
    postStartupData: noOpEffect,
    refreshCatalogData: () => Effect.void,
  };
}

export function createStubDesktopCredentialSettingsController(
  state: SettingsStatePorts,
  overrides: Partial<DesktopCredentialSettingsController> = {},
): DesktopCredentialSettingsController {
  return {
    profileHandlers: {
      signIn: noOpEffect,
      signOut: noOpEffect,
      setProviderKey: noOpEffect,
      removeProviderKey: noOpEffect,
      openProviderKeyUrl: noOpEffect,
      openExternalUrl: noOpEffect,
    },
    chatGptHandlers: {
      signInChatGpt: noOpEffect,
      signOutChatGpt: noOpEffect,
      setChatGptPreferSubscription: noOpEffect,
    },
    grokHandlers: {
      signInGrok: noOpEffect,
      signOutGrok: noOpEffect,
      setGrokPreferSubscription: noOpEffect,
    },
    // The same wiring the desktop root does: the reads are the programs the
    // window settles at its own message boundary.
    modelSelectionController: new SettingsModelSelectionController({
      stores: { ...makeFakeSettingsStores().stores, ...state },
      secrets: new FakeSecrets(),
      resolveModelOptions: (stores, models) =>
        Effect.map(
          readModelAvailabilityInputs(stores, models),
          modelOptionsFrom,
        ),
      copilotRoutes: discoveredCopilotRoutes(),
    }),
    refreshModelOptions: noOpEffect,
    postProfileData: noOpEffect,
    postStartupData: noOpEffect,
    postSubscriptionUsage: noOpEffect,
    refreshAfterProviderSettingChange: noOpEffect,
    refreshAuthDependentData: noOpEffect,
    signInChatGpt: noOpEffect,
    ...overrides,
  };
}

export function createStubDesktopToolingSettingsController(
  overrides: Partial<DesktopToolingSettingsController> = {},
): DesktopToolingSettingsController {
  return {
    toolHandlers: {
      openToolInstallUrl: noOpEffect,
      installToolExtension: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
      recheckToolStatus: noOpEffect,
      toggleTool: noOpEffect,
      runToolCommand: noOpEffect,
    },
    latexHandlers: {
      applyLatexSettings: unsupported(
        'Desktop cannot apply recommended VS Code settings.',
      ),
      installLatexWorkshop: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
      runInstallCommand: noOpEffect,
    },
    postLatexConfigValues: noOpEffect,
    postStartupData: noOpEffect,
    dispose: () => undefined,
    ...overrides,
  };
}
