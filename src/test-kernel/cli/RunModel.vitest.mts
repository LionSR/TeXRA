import { describe, expect, it } from 'vitest';

import { CliUsageError } from '@cli/runtime/cliContext';
import { assertExplicitModelKnown } from '@cli/runtime/runModel';

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

  it('normalizes user-facing model names to registry ids', () => {
    expect(assertExplicitModelKnown('glm5.2')).toBe('glm52');
    expect(assertExplicitModelKnown('GLM-5.2')).toBe('glm52');
    expect(assertExplicitModelKnown('glm-5.2')).toBe('glm52');
  });

  it('rejects ambiguous provider model names', () => {
    expect(() => assertExplicitModelKnown('claude-opus-4-7')).toThrow(
      CliUsageError,
    );
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
