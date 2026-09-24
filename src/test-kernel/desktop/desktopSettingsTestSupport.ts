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
    showInfoMessage: () => Effect.void,
    showErrorMessage: () => Effect.void,
    confirmAction: () => Effect.succeed(true),
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
    profileKeyController: {
      setProviderKey: noOpEffect,
      removeProviderKey: noOpEffect,
      openProviderKeyUrl: noOpEffect,
    },
    reportProviderKeyFailure: noOpEffect,
    refreshModelOptions: noOpEffect,
    postProfileData: noOpEffect,
    postStartupData: noOpEffect,
    postSubscriptionUsage: noOpEffect,
    refreshAfterProviderSettingChange: noOpEffect,
    refreshAfterProviderKeyChange: noOpEffect,
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
      installToolExtension: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
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
    postStartupData: noOpEffect,
    followToolAvailability: Effect.void,
    ...overrides,
  };
}
