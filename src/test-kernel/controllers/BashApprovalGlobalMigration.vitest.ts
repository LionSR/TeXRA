// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  BASH_APPROVAL_CONFIG_TARGET,
  migrateLegacyGlobalBashApprovalOverride,
} from '@controllers/settingsView/BashApprovalGlobalMigration';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { FakeScopedConfigProvider } from '@test/support/FakePlatform';

describe('migrateLegacyGlobalBashApprovalOverride', () => {
  it('migrates a pre-existing legacy global override to workspace scope and clears it globally', async () => {
    // Simulates a user who disabled bash approval before #7148, when the
    // extension still wrote it to the global scope (issue #7085 / #7169).
    const config = new FakeScopedConfigProvider();
    config.seedGlobal(BASH_APPROVAL_CONFIG_KEY, false);
    const workspaceState = new MemoryStateStore();

    await migrateLegacyGlobalBashApprovalOverride({ workspaceState, config });

    const inspection = config.inspect<boolean>(BASH_APPROVAL_CONFIG_KEY);
    // Effective behavior is preserved for this workspace...
    expect(inspection?.workspaceValue).toBe(false);
    expect(config.get<boolean>(BASH_APPROVAL_CONFIG_KEY, true)).toBe(false);
    // ...but now as a visible, correctable workspace-scoped override rather
    // than a silent global bypass, and the legacy global value is gone.
    expect(inspection?.globalValue).toBeUndefined();
    expect(
      config.updateCalls.some(
        (call) =>
          call.key === BASH_APPROVAL_CONFIG_KEY &&
          call.target === BASH_APPROVAL_CONFIG_TARGET &&
          call.value === false,
      ),
    ).toBe(true);
    // One-shot marker set so this workspace's migration never re-runs.
    expect(
      workspaceState.get<boolean>(
        WorkspaceStateKey.BASH_APPROVAL_GLOBAL_MIGRATED,
        false,
      ),
    ).toBe(true);
  });

  it('is a no-op when no legacy global override exists', async () => {
    const config = new FakeScopedConfigProvider();
    const workspaceState = new MemoryStateStore();

    await migrateLegacyGlobalBashApprovalOverride({ workspaceState, config });

    expect(config.updateCalls).toHaveLength(0);
    const inspection = config.inspect<boolean>(BASH_APPROVAL_CONFIG_KEY);
    expect(inspection?.workspaceValue).toBeUndefined();
    expect(inspection?.globalValue).toBeUndefined();
    // Still marks the workspace as migrated, so a later manual edit of the
    // (now cleared) global setting can't retroactively trigger a migration.
    expect(
      workspaceState.get<boolean>(
        WorkspaceStateKey.BASH_APPROVAL_GLOBAL_MIGRATED,
        false,
      ),
    ).toBe(true);
  });

  it('never re-runs once the per-workspace marker is already set', async () => {
    const config = new FakeScopedConfigProvider();
    config.seedGlobal(BASH_APPROVAL_CONFIG_KEY, false);
    const workspaceState = new MemoryStateStore();
    await workspaceState.update(
      WorkspaceStateKey.BASH_APPROVAL_GLOBAL_MIGRATED,
      true,
    );

    await migrateLegacyGlobalBashApprovalOverride({ workspaceState, config });

    expect(config.updateCalls).toHaveLength(0);
    expect(config.inspect<boolean>(BASH_APPROVAL_CONFIG_KEY)?.globalValue).toBe(
      false,
    );
  });

  it("does not overwrite a workspace's own explicit override, but still clears the stale global value", async () => {
    const config = new FakeScopedConfigProvider();
    config.seedGlobal(BASH_APPROVAL_CONFIG_KEY, false);
    // This workspace already has its own explicit value -- e.g. set via the
    // post-#7148 settings UI in an earlier session.
    await config.update(BASH_APPROVAL_CONFIG_KEY, true, 'workspace');
    const workspaceState = new MemoryStateStore();

    await migrateLegacyGlobalBashApprovalOverride({ workspaceState, config });

    const inspection = config.inspect<boolean>(BASH_APPROVAL_CONFIG_KEY);
    expect(inspection?.workspaceValue).toBe(true);
    expect(inspection?.globalValue).toBeUndefined();
  });

  it('respects a resource-scoped workspaceFolderValue override and does not overwrite it, but still clears the stale global value', async () => {
    // `texra.toolUse.requireBashApproval` is declared `resource`-scoped, so
    // post-#7148 UI writes commonly resolve as `workspaceFolderValue` rather
    // than `workspaceValue` -- the migration must treat that the same as an
    // explicit workspace override, not just copy the stale global `false`
    // over the top of it (issue #7169 bugbot follow-up).
    const config = new FakeScopedConfigProvider();
    config.seedGlobal(BASH_APPROVAL_CONFIG_KEY, false);
    config.seedWorkspaceFolder(BASH_APPROVAL_CONFIG_KEY, true);
    const workspaceState = new MemoryStateStore();

    await migrateLegacyGlobalBashApprovalOverride({ workspaceState, config });

    const inspection = config.inspect<boolean>(BASH_APPROVAL_CONFIG_KEY);
    // The folder-level override is left untouched...
    expect(inspection?.workspaceFolderValue).toBe(true);
    expect(inspection?.workspaceValue).toBeUndefined();
    // ...and no copy was made into workspace scope...
    expect(
      config.updateCalls.some(
        (call) => call.target === BASH_APPROVAL_CONFIG_TARGET,
      ),
    ).toBe(false);
    // ...but the stale global value is still cleared, since it no longer
    // needs to govern anything.
    expect(inspection?.globalValue).toBeUndefined();
    expect(
      workspaceState.get<boolean>(
        WorkspaceStateKey.BASH_APPROVAL_GLOBAL_MIGRATED,
        false,
      ),
    ).toBe(true);
  });

  it('leaves the one-shot marker unset when clearing the legacy global value fails, so a later activation retries the clear', async () => {
    // If `config.update(..., 'global')` throws (e.g. a transient VS Code
    // config-write failure), the marker must NOT be set -- otherwise this
    // workspace's migration is treated as "done" forever, and the stale
    // global `false` is left to silently keep bypassing approval in every
    // other, not-yet-migrated workspace with no way to ever retry the clear
    // (issue #7169 bugbot + claude-review follow-up).
    const config = new FakeScopedConfigProvider();
    config.seedGlobal(BASH_APPROVAL_CONFIG_KEY, false);
    config.failUpdatesForTarget = 'global';
    const workspaceState = new MemoryStateStore();

    await migrateLegacyGlobalBashApprovalOverride({ workspaceState, config });

    const inspection = config.inspect<boolean>(BASH_APPROVAL_CONFIG_KEY);
    // The workspace-scoped copy still succeeded (that update targets
    // 'workspace', not 'global', so it isn't the one that fails here)...
    expect(inspection?.workspaceValue).toBe(false);
    // ...but the global value is still there because the clear failed...
    expect(inspection?.globalValue).toBe(false);
    // ...so the one-shot marker must stay unset, giving a later activation
    // another chance to retry the clear.
    expect(
      workspaceState.get<boolean>(
        WorkspaceStateKey.BASH_APPROVAL_GLOBAL_MIGRATED,
        false,
      ),
    ).toBe(false);
  });
});
