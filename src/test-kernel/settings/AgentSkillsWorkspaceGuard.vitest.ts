// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  setAgentSkillsEnabled: vi.fn(),
  showLoggedInfoMessage: vi.fn(),
}));

vi.mock(
  '@shared/settingsView/handlers/agentSkillsHandlers',
  async (original) => {
    const actual =
      await original<
        typeof import('@shared/settingsView/handlers/agentSkillsHandlers')
      >();
    return {
      ...actual,
      setAgentSkillsEnabled: mocks.setAgentSkillsEnabled,
    };
  },
);

vi.mock('@frontend/ui/errorHandlingUtils', async (original) => {
  const actual =
    await original<typeof import('@frontend/ui/errorHandlingUtils')>();
  return {
    ...actual,
    showLoggedInfoMessage: mocks.showLoggedInfoMessage,
  };
});

// Local imports
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';

type AgentSkillsHarness = {
  handleSetAgentSkillsEnabled(enabled: boolean): Promise<void>;
  sendAgentSkillsSettings: ReturnType<typeof vi.fn>;
  withActiveWebview: (
    fn: (webview: vscode.Webview) => Promise<void> | void,
  ) => Promise<void>;
};

function createHarness(): AgentSkillsHarness {
  const handler = Object.create(SettingsViewMessageHandler.prototype);
  Reflect.set(handler, 'channel', 'SettingsViewMessageHandler');
  Reflect.set(handler, 'sendAgentSkillsSettings', vi.fn());
  Reflect.set(
    handler,
    'withActiveWebview',
    async (fn: (webview: vscode.Webview) => Promise<void> | void) => {
      await fn({} as vscode.Webview);
    },
  );
  return handler as AgentSkillsHarness;
}

describe('agent skills workspace guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    Reflect.deleteProperty(vscode.workspace, 'workspaceFolders');
  });

  it('restores the switch without writing in an empty VS Code window', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: undefined,
    });
    const handler = createHarness();

    await handler.handleSetAgentSkillsEnabled(false);

    expect(mocks.setAgentSkillsEnabled).not.toHaveBeenCalled();
    expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
      'SettingsViewMessageHandler',
      'Agent skills are a per-workspace setting. Open a workspace folder before changing them.',
    );
    expect(handler.sendAgentSkillsSettings).toHaveBeenCalledOnce();
  });
});
