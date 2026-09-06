// Third-party imports
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Local imports
import { Result } from 'effect';
import { parseJsonWith, safeParseJson } from '@common/parsing/safeParseJson';

describe('safeParseJson', () => {
  it('returns the parsed value for valid JSON', () => {
    const result = safeParseJson('{"a":1,"b":["x"]}');
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toEqual({ a: 1, b: ['x'] });
  });

  it('returns an error instead of throwing for malformed JSON', () => {
    const result = safeParseJson('{not json');
    expect(Result.isFailure(result)).toBe(true);
    expect(Result.merge(result)).toBeInstanceOf(Error);
  });
});

describe('parseJsonWith', () => {
  const schema = z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  });

  it('parses and validates against the schema', () => {
    const result = parseJsonWith('{"code":"E1","extra":true}', schema);
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toEqual({ code: 'E1' });
  });

  it('fails when the parsed value does not match the schema', () => {
    const result = parseJsonWith('"just a string"', schema);
    expect(Result.isFailure(result)).toBe(true);
    expect(Result.merge(result)).toBeInstanceOf(z.ZodError);
  });

  it('fails on malformed JSON without throwing', () => {
    const result = parseJsonWith('{nope', schema);
    expect(Result.isFailure(result)).toBe(true);
  });
});
