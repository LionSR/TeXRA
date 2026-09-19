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
    refreshCatalogData: () => Effect.void,
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
    signInChatGpt: noOp,
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
