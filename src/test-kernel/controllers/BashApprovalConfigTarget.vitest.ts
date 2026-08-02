// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { BASH_APPROVAL_CONFIG_TARGET } from '@controllers/settingsView/BashApprovalGlobalMigration';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { writeSetting } from '@shared/config/settingsAccess';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { settingsViewSettingByKey } from '@shared/schemas/stateSettings';
import { FakeConfigProvider } from '@test/support/FakePlatform';

describe('bash-approval config target', () => {
  it('is scoped per-workspace, not global', () => {
    // Bash approval gating is a security-adjacent bypass: disabling it in one
    // workspace must never disable it everywhere (issue #7085).
    expect(BASH_APPROVAL_CONFIG_TARGET).toBe('workspace');
  });

  it('the catalog writer persists it in workspace configuration', async () => {
    const config = new FakeConfigProvider();
    const stores = {
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      config,
    };
    const entry = settingsViewSettingByKey(BASH_APPROVAL_CONFIG_KEY);
    expect(entry).toBeDefined();

    await writeSetting(entry!, false, stores);

    expect(config.get(BASH_APPROVAL_CONFIG_KEY)).toBe(false);
    expect(config.inspect(BASH_APPROVAL_CONFIG_KEY)).toMatchObject({
      workspaceValue: false,
    });
  });
});
