// Standard library imports
import { strict as assert } from 'assert';

// Local imports - utils
import { executeCommand } from '@utils/system/execUtils';

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
