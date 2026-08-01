// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showLoggedErrorMessage: vi.fn(),
  showLoggedInfoMessage: vi.fn(),
  writeSetting: vi.fn(),
}));

vi.mock('@shared/config/settingsAccess', async (original) => {
  const actual =
    await original<typeof import('@shared/config/settingsAccess')>();
  return { ...actual, writeSetting: mocks.writeSetting };
});

vi.mock('@frontend/ui/errorHandlingUtils', async (original) => {
  const actual =
    await original<typeof import('@frontend/ui/errorHandlingUtils')>();
  return {
    ...actual,
    showLoggedErrorMessage: mocks.showLoggedErrorMessage,
    showLoggedInfoMessage: mocks.showLoggedInfoMessage,
  };
});

// Local imports
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas/agentSkills';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: undefined });

type AgentSkillsHarness = {
  updateStateSetting(key: string, value: unknown): Promise<void>;
  postStateSettingSnapshot: ReturnType<typeof vi.fn>;
};

type SnapshotHarness = {
  postStateSettingSnapshot(snapshot: 'multi-agent'): Promise<void>;
};

function createHarness(): AgentSkillsHarness {
  const handler = Object.create(SettingsViewMessageHandler.prototype);
  Reflect.set(handler, 'channel', 'SettingsViewMessageHandler');
  Reflect.set(handler, 'postStateSettingSnapshot', vi.fn());
  return handler as AgentSkillsHarness;
}

describe('agent skills workspace guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('restores the switch without writing in an empty VS Code window', async () => {
    const handler = createHarness();

    await handler.updateStateSetting(AGENT_SKILLS_CONFIG_KEY, false);

    expect(mocks.writeSetting).not.toHaveBeenCalled();
    expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
      'SettingsViewMessageHandler',
      'Open a workspace folder before changing the “Agent skills” setting.',
    );
    expect(handler.postStateSettingSnapshot).toHaveBeenCalledWith(
      'agent-skills',
    );
  });

  it('surfaces write failures and restores the owning snapshot', async () => {
    const handler = createHarness();
    const error = new Error('write failed');
    mocks.writeSetting.mockRejectedValueOnce(error);

    await handler.updateStateSetting(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      true,
    );

    expect(mocks.showLoggedInfoMessage).not.toHaveBeenCalled();
    expect(mocks.showLoggedErrorMessage).toHaveBeenCalledWith(
      'SettingsViewMessageHandler',
      'Failed to update “Keep subagents running”',
      error,
    );
    expect(handler.postStateSettingSnapshot).toHaveBeenCalledWith(
      'multi-agent',
    );
  });

  it('routes the multi-agent snapshot to its status sender', async () => {
    const handler = Object.create(
      SettingsViewMessageHandler.prototype,
    ) as SnapshotHarness;
    const webview = {};
    const sendSuperYoloEnabled = vi.fn(async () => undefined);
    Reflect.set(handler, 'sendSuperYoloEnabled', sendSuperYoloEnabled);
    Reflect.set(
      handler,
      'withActiveWebview',
      vi.fn(async (fn: (activeWebview: object) => Promise<void>) =>
        fn(webview),
      ),
    );

    await handler.postStateSettingSnapshot('multi-agent');

    expect(sendSuperYoloEnabled).toHaveBeenCalledWith(webview);
  });
});
