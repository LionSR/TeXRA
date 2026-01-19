// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { buildArguments, type GrepInput } from '@tools/grep';

describe('buildArguments', () => {
  // output_mode is required after transform normalizes nullish to 'content'
  const baseInput: GrepInput = { pattern: 'example', output_mode: 'content' };

  it('omits --files-with-matches when using content mode', () => {
    const args = buildArguments(baseInput, 'content');
    assert.deepEqual(args, ['--color=never']);
  });

  it('includes --files-with-matches when explicitly requested', () => {
    const args = buildArguments(baseInput, 'files_with_matches');
    assert.ok(args.includes('--files-with-matches'));
  });

  it('includes --fixed-strings when literal is true', () => {
    const args = buildArguments({ ...baseInput, literal: true }, 'content');
    assert.ok(args.includes('--fixed-strings'));
  });

  it('omits --fixed-strings when literal is false or nullish', () => {
    const argsWithFalse = buildArguments(
      { ...baseInput, literal: false },
      'content',
    );
    const argsWithNull = buildArguments(
      { ...baseInput, literal: null },
      'content',
    );
    const argsWithUndefined = buildArguments(baseInput, 'content');

    assert.ok(!argsWithFalse.includes('--fixed-strings'));
    assert.ok(!argsWithNull.includes('--fixed-strings'));
    assert.ok(!argsWithUndefined.includes('--fixed-strings'));
  });
});
