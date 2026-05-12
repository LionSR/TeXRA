import { describe, expect, it } from 'vitest';

import { parseOriginHeadDefaultBranch } from '@tools/github/githubSubscriptionTool';

describe('parseOriginHeadDefaultBranch', () => {
  it('extracts the branch name from origin HEAD symbolic refs', () => {
    expect(parseOriginHeadDefaultBranch('origin/main')).toBe('main');
    expect(parseOriginHeadDefaultBranch('refs/remotes/origin/trunk')).toBe(
      'trunk',
    );
  });

  it('ignores non-origin symbolic refs', () => {
    expect(parseOriginHeadDefaultBranch('upstream/main')).toBeUndefined();
    expect(
      parseOriginHeadDefaultBranch('refs/remotes/upstream/main'),
    ).toBeUndefined();
  });
});
