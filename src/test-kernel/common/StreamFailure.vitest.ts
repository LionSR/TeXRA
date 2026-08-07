import { describe, expect, it } from 'vitest';

import {
  detectPartialText,
  handleStreamingFailure,
} from '@common/errors/sdkErrorUtils';

describe('handleStreamingFailure', () => {
  it.each([
    {
      name: 'attaches partial text',
      tail: 'partial tail',
      expected: 'partial tail' as string | undefined,
    },
    {
      name: 'no-ops partial-text attach for an empty tail',
      tail: '',
      expected: undefined,
    },
  ])('$name', ({ tail, expected }) => {
    const err = new Error('boom');
    expect(() =>
      handleStreamingFailure(err, { partialTail: () => tail }),
    ).toThrow(err);
    expect(detectPartialText(err)).toBe(expected);
  });
});
