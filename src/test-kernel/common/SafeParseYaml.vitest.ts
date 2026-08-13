// Third-party imports
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Local imports
import { parseYamlWith, safeParseYaml } from '@common/parsing/safeParseYaml';

describe('safeParseYaml', () => {
  it('returns the parsed value for valid YAML', () => {
    const result = safeParseYaml('a: 1\nb:\n  - x\n');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ a: 1, b: ['x'] });
  });

  it('returns an error instead of throwing for malformed YAML', () => {
    const result = safeParseYaml('a: "unterminated');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(Error);
  });
});

describe('parseYamlWith', () => {
  const schema = z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  });

  it('parses and validates against the schema', () => {
    const result = parseYamlWith('code: E1\nextra: true\n', schema);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ code: 'E1' });
  });

  it('fails when the parsed value does not match the schema', () => {
    const result = parseYamlWith('"just a string"', schema);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(z.ZodError);
  });

  it('fails on malformed YAML without throwing', () => {
    const result = parseYamlWith('a: "unterminated', schema);
    expect(result.isErr()).toBe(true);
  });
});
