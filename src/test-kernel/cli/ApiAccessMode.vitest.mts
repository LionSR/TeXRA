// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI runtime
import {
  CLI_API_MODE_INPUTS,
  parseCliApiMode,
} from '@cli/runtime/apiAccessMode';

describe('CLI API access mode aliases', () => {
  it('parses every advertised API mode input', () => {
    expect(CLI_API_MODE_INPUTS.every((input) => parseCliApiMode(input))).toBe(
      true,
    );
  });

  it('maps the relay and byok shorthands to their canonical modes', () => {
    expect(parseCliApiMode('relay')).toBe('included');
    expect(parseCliApiMode('byok')).toBe('personal');
  });

  it('rejects the removed undocumented synonyms', () => {
    for (const removed of ['texra', 'direct', 'api', 'key', 'keys']) {
      expect(parseCliApiMode(removed)).toBeUndefined();
    }
  });
});
