// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { DefaultDesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import { DefaultDesktopCrashReportingSettingsController } from '@desktop/main/desktopCrashReportingSettingsController';
import { DefaultDesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import { DesktopHistoryHandlers } from '@desktop/main/desktopHistoryHandlers';
import { DefaultDesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { unsupportedCommands } from '@shared/utils/dispatcher';
import {
  FakeConfigProvider,
  FakeSecrets,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

// Local file imports
import {
  createStubDesktopAgentSettingsController,
  createStubDesktopCrashReportingSettingsController,
  createStubDesktopCredentialSettingsController,
  createStubDesktopHistoryOptions,
  createStubDesktopHistorySettingsController,
  createStubDesktopToolingSettingsController,
} from './desktopSettingsTestSupport';
import { repoPath } from './desktopTestPaths.mjs';

const noOp = async (): Promise<void> => undefined;

function statePorts() {
  return {
    globalState: new FakeStateStore(),
    workspaceState: new FakeStateStore(),
  };
}

function realAgentController(): DefaultDesktopAgentSettingsController {
  return new DefaultDesktopAgentSettingsController({
    ...statePorts(),
    registry: {
      loadAgents: noOp,
      refreshAgents: noOp,
      loadAgentOptionsData: async () => ({ workflow: [], toolUse: [] }),
      getAgents: () => [],
      getVisibleAgents: () => [],
    },
    directory: {
      getCustomAgentDirectory: async () => '/agents',
      getSourceDirectory: async () => undefined,
      selectCustomAgentDirectory: async () => undefined,
      openPath: noOp,
      revealPath: noOp,
    },
    renderer: { postToRenderer: () => undefined },
    prompts: {
      promptText: async () => undefined,
      confirm: async () => false,
      chooseTeamAvailability: async () => 'cancel',
    },
    resourcesPath: repoPath('packages', 'extension', 'resources'),
    remoteCatalog: {
      canAccess: async () => false,
      signIn: async () => false,
    },
    notifications: { showInfoMessage: noOp, showErrorMessage: noOp },
  });
}

function realCrashReportingController(): DefaultDesktopCrashReportingSettingsController {
  return new DefaultDesktopCrashReportingSettingsController({
    state: new FakeStateStore(),
    secrets: new FakeSecrets(),
    renderer: { postToRenderer: () => undefined },
    prompt: { input: async () => undefined },
    initialization: { initialize: noOp },
  });
}

function realCredentialController(): DefaultDesktopCredentialSettingsController {
  return new DefaultDesktopCredentialSettingsController({
    ...statePorts(),
    config: new FakeConfigProvider(),
    secrets: new FakeSecrets(),
    renderer: { postToRenderer: () => undefined },
    prompt: {
      input: async () => undefined,
      confirm: async () => false,
    },
    externalOpener: {
      openExternal: noOp,
      presentChatGptSignInUrl: () => undefined,
    },
    notifications: {
      showInfoMessage: noOp,
      showWarningMessage: noOp,
      showErrorMessage: noOp,
    },
    auth: { signIn: noOp, signOut: noOp },
    setUseIncludedModelAccess: noOp,
    modelSelectionExtras: {
      useIncludedAccess: () => false,
      getUserTier: () => undefined,
    },
    modelListRefresh: Promise.resolve(),
    onCredentialChanged: noOp,
    onError: () => undefined,
  });
}

function realToolingController(): DefaultDesktopToolingSettingsController {
  return new DefaultDesktopToolingSettingsController({
    ...statePorts(),
    onError: () => undefined,
    renderer: { postToRenderer: () => undefined },
    dashboard: {
      buildItems: async () => [],
      getCachedCheckResults: async () => undefined,
      refreshAvailability: noOp,
      refreshDisabledCache: noOp,
      planTerminalAction: async () => ({
        kind: 'none',
        reason: 'unknownTool',
      }),
    },
    navigation: { openExternal: noOp, presentExtensionInstall: noOp },
    commands: { run: noOp },
    latexToolingController: new LatexToolingController({
      checkToolInstalled: async () => false,
      findPath: () => null,
      detectPackageManager: () => null,
      getPlatform: () => 'linux',
      isLatexWorkshopInstalled: () => false,
      getRecommendedStatus: () => ({
        outDir: false,
        autoRevealExclude: false,
      }),
    }),
    latexConfigPersistenceController: new LatexConfigPersistenceController(),
  });
}

/**
 * The desktop settings fixture builds its registry from stub controllers, so
 * the capability broadcast it asserts is only as accurate as those stubs.
 * These cases pin each stub's `unsupported(...)` markers to the markers the
 * real controller declares, plus the literal expectation for the host, so a
 * production capability decision cannot change without a failing test here.
 */
describe('desktop settings capability markers', () => {
  beforeEach(async () => {
    await installPlatform({ workspacePath: '/workspace' });
  });

  it('matches the real credential controller, which excludes VS Code provider settings', () => {
    const real = realCredentialController();
    const stub = createStubDesktopCredentialSettingsController(statePorts());

    expect(unsupportedCommands(real.profileActions)).toEqual([
      'setProviderVscodeSetting',
    ]);
    expect(unsupportedCommands(real.chatGptActions)).toEqual([]);
    expect(unsupportedCommands(stub.profileActions)).toEqual(
      unsupportedCommands(real.profileActions),
    );
    expect(unsupportedCommands(stub.chatGptActions)).toEqual(
      unsupportedCommands(real.chatGptActions),
    );
  });

  it('matches the real agent, crash-reporting, and history controllers, which support every action', () => {
    const domains = [
      {
        name: 'agent',
        real: realAgentController().actions,
        stub: createStubDesktopAgentSettingsController().actions,
      },
      {
        name: 'crashReporting',
        real: realCrashReportingController().actions,
        stub: createStubDesktopCrashReportingSettingsController().actions,
      },
      {
        name: 'history',
        real: new DesktopHistoryHandlers(createStubDesktopHistoryOptions())
          .actions,
        stub: createStubDesktopHistorySettingsController().actions,
      },
    ];

    for (const { name, real, stub } of domains) {
      expect([name, unsupportedCommands(real)]).toEqual([name, []]);
      expect([name, unsupportedCommands(stub)]).toEqual([
        name,
        unsupportedCommands(real),
      ]);
    }
  });

  it('matches the real tooling controller, which supports every tools and LaTeX action', () => {
    const real = realToolingController();
    const stub = createStubDesktopToolingSettingsController();

    expect(unsupportedCommands(real.toolsActions)).toEqual([]);
    expect(unsupportedCommands(real.latexActions)).toEqual([]);
    expect(unsupportedCommands(stub.toolsActions)).toEqual(
      unsupportedCommands(real.toolsActions),
    );
    expect(unsupportedCommands(stub.latexActions)).toEqual(
      unsupportedCommands(real.latexActions),
    );
  });
});
