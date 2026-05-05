import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';

import { resolveWorkspacePath } from '../../../packages/desktop/src/main/platform/paths';

describe('desktop workspace path', () => {
  it('resolves CLI workspace path before env and stored state', () => {
    assert.equal(
      resolveWorkspacePath({
        argv: ['--texra-workspace', 'cli-workspace'],
        env: { TEXRA_WORKSPACE_PATH: 'env-workspace' },
      }),
      resolve('cli-workspace'),
    );
  });

  it('does not persist or restore selected workspace folders yet', () => {
    assert.equal(
      resolveWorkspacePath({
        argv: [],
        env: {},
      }),
      undefined,
    );
  });
});
