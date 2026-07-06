// Standard library imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports
import { CORE_SETTING_PATHS } from '@shared/schemas/coreSettings';
import { SETTING_KEY } from '@shared/config/settingKeys';

describe('SETTING_KEY', () => {
  it('has exactly one canonical texra.-prefixed entry per core setting path', () => {
    assert.deepEqual(
      Object.keys(SETTING_KEY).sort(),
      [...CORE_SETTING_PATHS].sort(),
    );

    for (const path of CORE_SETTING_PATHS) {
      assert.equal(SETTING_KEY[path], `texra.${path}`);
    }
  });
});
