import { beforeEach, describe, expect, it } from 'vitest';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { DefaultDesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import { DefaultDesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import { DefaultDesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { unsupportedCommands } from '@shared/utils/dispatcher';
import {
  FakeConfigProvider,
  FakeSecrets,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

import {
  createStubDesktopAgentSettingsController,
  createStubDesktopCredentialSettingsController,
  createStubDesktopToolingSettingsController,
} from './desktopSettingsTestSupport';
import { repoPath } from './desktopTestPaths.ts';

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
      openSubscriptionSignInUrl: noOp,
      presentSubscriptionSignInUrl: () => undefined,
      presentSubscriptionDeviceCode: () => undefined,
    },
    notifications: {
      showInfoMessage: noOp,
      showWarningMessage: noOp,
      showErrorMessage: noOp,
    },
    auth: { signIn: noOp, signOut: noOp },
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
      planTerminalAction: async () => ({
        kind: 'none',
        reason: 'unknownTool',
      }),
    },
    navigation: { openExternal: noOp },
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

/** Pin the real markers to the literal expectation, then pin the stub to the real. */
function expectStubMirrorsReal(
  realHandlers: Readonly<Record<string, unknown>>,
  stubHandlers: Readonly<Record<string, unknown>>,
  expectedRealMarkers: readonly string[],
): void {
  expect(unsupportedCommands(realHandlers)).toEqual(expectedRealMarkers);
  expect(unsupportedCommands(stubHandlers)).toEqual(
    unsupportedCommands(realHandlers),
  );
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

  it('matches the real credential controller, which supports every action', () => {
    const real = realCredentialController();
    const stub = createStubDesktopCredentialSettingsController(statePorts());

    for (const key of [
      'profileHandlers',
      'chatGptHandlers',
      'grokHandlers',
    ] as const) {
      expectStubMirrorsReal(real[key], stub[key], []);
    }
  });

  it('matches the real agent controller, which supports every action', () => {
    const real = realAgentController().handlers;
    const stub = createStubDesktopAgentSettingsController().handlers;

    expect(unsupportedCommands(real)).toEqual([]);
    expect(unsupportedCommands(stub)).toEqual(unsupportedCommands(real));
  });

  it('matches the real tooling controller, which excludes VS Code-only actions', () => {
    const real = realToolingController();
    const stub = createStubDesktopToolingSettingsController();

    expectStubMirrorsReal(real.toolHandlers, stub.toolHandlers, [
      'installToolExtension',
    ]);
    expectStubMirrorsReal(real.latexHandlers, stub.latexHandlers, [
      'applyLatexSettings',
      'installLatexWorkshop',
    ]);
  });
});
