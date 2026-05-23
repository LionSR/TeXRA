import { describe, expect, it } from 'vitest';

import { CliUsageError } from '../../../packages/cli/src/runtime/cliContext';
import { assertExplicitModelKnown } from '../../../packages/cli/src/commands/_helpers/modelArg';

describe('assertExplicitModelKnown', () => {
  it('returns undefined when no model flag was passed', () => {
    expect(assertExplicitModelKnown(undefined)).toBeUndefined();
    expect(assertExplicitModelKnown('')).toBeUndefined();
    expect(assertExplicitModelKnown('   ')).toBeUndefined();
  });

  it('returns the trimmed value for a known model id', () => {
    expect(assertExplicitModelKnown('sonnet46T')).toBe('sonnet46T');
    expect(assertExplicitModelKnown('  deepseekT  ')).toBe('deepseekT');
  });

  it('throws a CliUsageError for an unknown model id', () => {
    expect(() => assertExplicitModelKnown('nonexistent-model-xyz')).toThrow(
      CliUsageError,
    );
    expect(() => assertExplicitModelKnown('nonexistent-model-xyz')).toThrow(
      /Model not found: nonexistent-model-xyz/,
    );
    expect(() => assertExplicitModelKnown('nonexistent-model-xyz')).toThrow(
      /texra models list/,
    );
  });
});
