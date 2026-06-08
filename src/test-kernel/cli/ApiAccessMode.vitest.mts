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

  it('maps included-relay and personal-key aliases to their canonical modes', () => {
    expect(parseCliApiMode('relay')).toBe('included');
    expect(parseCliApiMode('texra')).toBe('included');
    expect(parseCliApiMode('byok')).toBe('personal');
    expect(parseCliApiMode('keys')).toBe('personal');
  });
});
