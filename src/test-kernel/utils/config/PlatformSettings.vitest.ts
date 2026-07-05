// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { installPlatform } from '@test/support/setupPlatform';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from '@utils/config/platformSettings';

function initWith(options: {
  workspaceState?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
}): Promise<void> {
  return installPlatform(options);
}

describe('readPlatformSetting', () => {
  it('resolves the default from the catalog schema when the key is unset', async () => {
    await initWith({});
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      LATEX_CONFIG_DEFAULTS.latexFormatter,
    );
    // A globalState-slot key resolves the same way.
    expect(readPlatformSetting(GlobalStateKey.WEBSOCKET_OPENAI)).toBe(false);
  });

  it('returns the stored value when present and valid', async () => {
    await initWith({
      workspaceState: { [WorkspaceStateKey.LATEX_FORMATTER]: 'tex-fmt' },
    });
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      'tex-fmt',
    );
  });

  it('snaps a stored value that fails the schema back to the catalog default', async () => {
    await initWith({
      workspaceState: {
        [WorkspaceStateKey.LATEX_FORMATTER]: 'not-a-formatter',
      },
    });
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      LATEX_CONFIG_DEFAULTS.latexFormatter,
    );
  });

  it('throws for a key with no catalog entry', async () => {
    await initWith({});
    expect(() => readPlatformSetting('texra.not.a.catalog.key')).toThrow(
      /no state-setting catalog entry/i,
    );
  });
});
