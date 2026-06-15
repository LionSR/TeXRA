// Third-party imports
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Local imports
import { parseJsonWith, safeParseJson } from '@common/parsing/safeParseJson';

describe('safeParseJson', () => {
  it('returns the parsed value for valid JSON', () => {
    const result = safeParseJson('{"a":1,"b":["x"]}');
    expect(result).toEqual({ ok: true, value: { a: 1, b: ['x'] } });
  });

  it('returns an error instead of throwing for malformed JSON', () => {
    const result = safeParseJson('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});

describe('parseJsonWith', () => {
  const schema = z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  });

  it('parses and validates against the schema', () => {
    const result = parseJsonWith('{"code":"E1","extra":true}', schema);
    expect(result).toEqual({ ok: true, value: { code: 'E1' } });
  });

  it('fails when the parsed value does not match the schema', () => {
    const result = parseJsonWith('"just a string"', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  it('fails on malformed JSON without throwing', () => {
    const result = parseJsonWith('{nope', schema);
    expect(result.ok).toBe(false);
  });
});
