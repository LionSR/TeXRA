import { describe, expect, it } from 'vitest';

import {
  detectPartialText,
  handleStreamingFailure,
} from '@common/errors/sdkErrorUtils';

describe('handleStreamingFailure', () => {
  it('attaches partial text', () => {
    const err = new Error('boom');
    expect(() =>
      handleStreamingFailure(err, { partialTail: () => 'partial tail' }),
    ).toThrow(err);
    expect(detectPartialText(err)).toBe('partial tail');
  });

  it('no-ops partial-text attach for an empty tail', () => {
    const err = new Error('boom');
    expect(() =>
      handleStreamingFailure(err, { partialTail: () => '' }),
    ).toThrow(err);
    expect(detectPartialText(err)).toBeUndefined();
  });
});
