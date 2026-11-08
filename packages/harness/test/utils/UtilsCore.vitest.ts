import { describe, expect, it } from 'vitest';
import { deriveRunId } from '@utils/core/idHash';

describe('deriveRunId', () => {
  it('is stable across identity field order', () => {
    expect(deriveRunId({ parent: 'abc', attempt: 2 })).toBe(
      deriveRunId({ attempt: 2, parent: 'abc' }),
    );
  });
});
