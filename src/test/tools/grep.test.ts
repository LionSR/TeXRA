// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { buildArguments, type GrepInput } from '@tools/grep';

describe('buildArguments', () => {
  const baseInput: GrepInput = { pattern: 'example' };

  it('omits --files-with-matches when using content mode', () => {
    const args = buildArguments(baseInput, 'content');
    assert.deepEqual(args, ['--color=never']);
  });

  it('includes --files-with-matches when explicitly requested', () => {
    const args = buildArguments(baseInput, 'files_with_matches');
    assert.ok(args.includes('--files-with-matches'));
  });
});
