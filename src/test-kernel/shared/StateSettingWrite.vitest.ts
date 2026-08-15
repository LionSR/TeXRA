// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { resolveStateSettingWrite } from '@shared/settingsView/handlers/stateSettingWrite';

describe('resolveStateSettingWrite', () => {
  it('resolves state-backed and core-config rows through one boundary', () => {
    expect(
      resolveStateSettingWrite(
        WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
        true,
      ),
    ).toMatchObject({
      kind: 'write',
      entry: {
        key: WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
        settingsViewSnapshot: 'multi-agent',
      },
      value: true,
    });
    expect(
      resolveStateSettingWrite(BASH_APPROVAL_CONFIG_KEY, false),
    ).toMatchObject({
      kind: 'write',
      entry: {
        key: BASH_APPROVAL_CONFIG_KEY,
        store: 'config',
        settingsViewSnapshot: 'approval',
      },
      value: false,
    });
  });

  it('uses null as an explicit reset and omission as a no-op', () => {
    expect(
      resolveStateSettingWrite(WorkspaceStateKey.LATEX_FORMATTER, null),
    ).toMatchObject({
      kind: 'reset',
      entry: {
        key: WorkspaceStateKey.LATEX_FORMATTER,
        settingsViewSnapshot: 'latex',
      },
    });
    expect(
      resolveStateSettingWrite(WorkspaceStateKey.LATEX_FORMATTER, undefined),
    ).toBeNull();
  });

  it('ignores unknown keys and preserves catalog validation errors', () => {
    expect(resolveStateSettingWrite('texra.unknown', true)).toBeNull();
    expect(
      resolveStateSettingWrite(
        WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
        1000.5,
      ),
    ).toMatchObject({
      kind: 'rejected',
      entry: {
        key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
        settingsViewSnapshot: 'latex',
      },
      error: expect.any(Error),
    });
  });
});
