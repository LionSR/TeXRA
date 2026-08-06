import { describe, expect, it } from 'vitest';

import { parseOriginHeadDefaultBranch } from '@tools/github/githubSubscriptionTool';

describe('parseOriginHeadDefaultBranch', () => {
  it.each([
    { ref: 'origin/main', expected: 'main' },
    { ref: 'refs/remotes/origin/trunk', expected: 'trunk' },
    { ref: 'upstream/main', expected: undefined },
    { ref: 'refs/remotes/upstream/main', expected: undefined },
  ])('parses $ref', ({ ref, expected }) => {
    expect(parseOriginHeadDefaultBranch(ref)).toBe(expected);
  });
});
