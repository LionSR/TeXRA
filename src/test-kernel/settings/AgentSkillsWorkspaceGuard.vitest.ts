// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
    showLoggedInfoMessage: mocks.showLoggedInfoMessage,
  };
});

// Local imports
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas/agentSkills';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: undefined });

type AgentSkillsHarness = {
  updateStateSetting(key: string, value: unknown): Promise<void>;
  postStateSettingSnapshot: ReturnType<typeof vi.fn>;
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
      'This is a per-workspace setting. Open a workspace folder before changing it.',
    );
    expect(handler.postStateSettingSnapshot).toHaveBeenCalledWith(
      'agent-skills',
    );
  });
});
