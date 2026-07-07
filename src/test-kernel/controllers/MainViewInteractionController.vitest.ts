// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - common
import { MainViewInteractionController } from '@controllers/mainView/MainViewInteractionController';
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - controllers

function createController(options?: {
  providerUrls?: Record<string, string | undefined>;
  docsCommands?: Record<string, string | undefined>;
}): MainViewInteractionController {
  return new MainViewInteractionController({
    getProviderUrl: (provider) => options?.providerUrls?.[provider],
    getToolDocsCommand: (tool) => options?.docsCommands?.[tool],
  });
}

describe('MainViewInteractionController', () => {
  it('routes switch-view messages to concrete VS Code commands', () => {
    const controller = createController();

    assert.deepEqual(
      controller.getSwitchViewCommand({
        command: COMMON_COMMANDS.SWITCH_VIEW,
        view: 'dashboard',
      }),
      { command: 'texra.showDashboard', args: [] },
    );
    assert.deepEqual(
      controller.getSwitchViewCommand({
        command: COMMON_COMMANDS.SWITCH_VIEW,
        view: 'main',
      }),
      { command: 'texra.showMainView', args: [] },
    );
    assert.deepEqual(
      controller.getSwitchViewCommand({
        command: COMMON_COMMANDS.SWITCH_VIEW,
        view: 'progress',
        openInEditor: true,
      }),
      { command: 'texra.openProgressViewInTab', args: [] },
    );
    assert.deepEqual(
      controller.getSwitchViewCommand({
        command: COMMON_COMMANDS.SWITCH_VIEW,
        view: 'progress',
      }),
      { command: 'texra.showProgressView', args: [{ inPlace: true }] },
    );
  });

  it('plans settings entry points', () => {
    const controller = createController();

    assert.deepEqual(
      controller.getOpenSettingsCommand('@ext:texra.extension'),
      {
        command: 'workbench.action.openSettings',
        args: ['@ext:texra.extension'],
      },
    );
    assert.deepEqual(
      controller.getOpenAgentSettingsCommand({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
        sessionType: 'toolUse',
      }),
      { command: 'texra.showAgents', args: ['toolUse'] },
    );
    assert.deepEqual(
      controller.getOpenAgentSettingsCommand({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
        sessionType: 'workflow',
      }),
      { command: 'texra.showAgents', args: [undefined] },
    );
  });

  it('keeps agent-directory resolution separate from the side effect', () => {
    const controller = createController();

    assert.deepEqual(
      controller.getAgentDirectoryAction({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
        customDirSet: false,
      }),
      { kind: 'openAgentSettings' },
    );
    assert.deepEqual(
      controller.getAgentDirectoryAction({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
        customDirSet: true,
      }),
      { kind: 'revealCustomDirectory' },
    );
  });

  it('resolves provider key commands and URLs', () => {
    const controller = createController({
      providerUrls: { openai: 'https://platform.openai.com/api-keys' },
    });

    assert.deepEqual(
      controller.getSetProviderApiKeyCommand({
        command: MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY,
        provider: 'openai',
      }),
      { command: 'texra.setApiKey', args: ['openai'] },
    );
    assert.equal(
      controller.getProviderApiKeyUrl({
        command: MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL,
        provider: 'openai',
      }),
      'https://platform.openai.com/api-keys',
    );
    assert.equal(
      controller.getProviderApiKeyUrl({
        command: MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL,
        provider: 'missing',
      }),
      undefined,
    );
    assert.equal(
      controller.getApiKeyGuideUrl(),
      'https://texra.ai/guide/installation#setting-up-api-keys',
    );
  });

  it('plans install guide commands from tool metadata', () => {
    const controller = createController({
      docsCommands: { latexindent: 'texra.openDoc,installation' },
    });

    assert.deepEqual(
      controller.getInstallGuideCommand({
        command: MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE,
        tool: 'latexindent',
      }),
      { command: 'texra.openDoc', args: ['installation'] },
    );
    assert.equal(
      controller.getInstallGuideCommand({
        command: MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE,
        tool: 'unknown',
      }),
      null,
    );
  });

  it('builds dependency banner messages from dependency results', () => {
    const controller = createController();

    assert.deepEqual(controller.getDependencyBannerMessage([]), {
      command: MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER,
    });
    assert.deepEqual(
      controller.getDependencyBannerMessage(['latexindent', 'gs']),
      {
        command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
        missingTools: ['latexindent', 'gs'],
      },
    );
  });

  it('maps dismissed banners to their config updates', () => {
    const controller = createController();

    assert.deepEqual(
      controller.getDismissConfigUpdate({
        command: MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER,
      }),
      { key: 'ui.showLoginBanner', value: false },
    );
    assert.deepEqual(
      controller.getDismissConfigUpdate({
        command: MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER,
      }),
      { key: 'ui.showOrchestratorBanner', value: false },
    );
  });
});
