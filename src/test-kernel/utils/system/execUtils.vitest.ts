// Third-party imports
import { strict as assert } from 'node:assert';
import { beforeAll, describe, it } from 'vitest';

// Standard library imports

// Local imports - test support
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - utils
import { executeCommand } from '@utils/system/execUtils';

beforeAll(async () => {
  // executeCommand resolves its cwd from the workspace; point the fake
  // platform at a directory that exists on disk so spawning succeeds.
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform({ workspacePath: process.cwd() }));
});

describe('executeCommand', () => {
  it('runs string commands with shell operators intact', async () => {
    const result = await executeCommand(
      'node -e "process.stdout.write(\'one\')" && echo two',
    );

    assert.ok(result.success);
    assert.strictEqual(result.stdout, 'onetwo');
    assert.strictEqual(result.stderr, null);
  });

  it('preserves fallback execution with logical OR', async () => {
    const result = await executeCommand(
      'node -e "process.exit(1)" || echo fallback',
    );

    assert.ok(result.success);
    assert.strictEqual(result.stdout, 'fallback');
    assert.strictEqual(result.stderr, null);
  });
});
