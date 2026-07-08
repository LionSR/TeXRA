import { describe, expect, it } from 'vitest';

import { splitCommitLines } from '@utils/git/commitLogFormat';

describe('splitCommitLines', () => {
  it('splits multiple commit labels on their own lines', () => {
    const stdout = [
      'abc1234: Add feature (2 days ago)',
      'def5678: Fix: handle edge case (3 days ago)',
    ].join('\n');

    expect(splitCommitLines(stdout)).toEqual([
      'abc1234: Add feature (2 days ago)',
      'def5678: Fix: handle edge case (3 days ago)',
    ]);
  });

  it('drops a trailing blank line instead of returning an empty commit label', () => {
    const stdout = 'abc1234: Add feature (2 days ago)\n';

    expect(splitCommitLines(stdout)).toEqual([
      'abc1234: Add feature (2 days ago)',
    ]);
  });

  it('returns an empty array for a zero-commit repo (empty stdout)', () => {
    expect(splitCommitLines('')).toEqual([]);
  });

  it('drops interior blank lines', () => {
    const stdout = ['abc1234: Add feature (2 days ago)', '', 'badrow'].join(
      '\n',
    );

    expect(splitCommitLines(stdout)).toEqual([
      'abc1234: Add feature (2 days ago)',
      'badrow',
    ]);
  });
});
