import { describe, expect, it } from 'vitest';

import { diffActiveChildren } from '@shared/streams/childActivityReducer';

interface Child {
  readonly executionId: string;
}

function child(executionId: string): Child {
  return { executionId };
}

describe('diffActiveChildren', () => {
  it('reports no vanished ids when previous is empty', () => {
    const { next, vanishedIds } = diffActiveChildren([], [child('a')]);

    expect(next).toEqual([child('a')]);
    expect(vanishedIds.size).toBe(0);
  });

  it('reports all previous ids as vanished when next is empty', () => {
    const { vanishedIds } = diffActiveChildren([child('a'), child('b')], []);

    expect(vanishedIds).toEqual(new Set(['a', 'b']));
  });

  it('reports only the ids that dropped out on partial overlap', () => {
    const { vanishedIds } = diffActiveChildren(
      [child('a'), child('b'), child('c')],
      [child('b'), child('c'), child('d')],
    );

    expect(vanishedIds).toEqual(new Set(['a']));
  });

  it('is unaffected by duplicate ids in either input', () => {
    const { vanishedIds } = diffActiveChildren(
      [child('a'), child('a'), child('b')],
      [child('a')],
    );

    expect(vanishedIds).toEqual(new Set(['b']));
  });

  it('reports nothing vanished when previous and next are identical', () => {
    const { vanishedIds } = diffActiveChildren(
      [child('a'), child('b')],
      [child('a'), child('b')],
    );

    expect(vanishedIds.size).toBe(0);
  });

  it('passes next through unchanged', () => {
    const nextList = [child('a')];
    const { next } = diffActiveChildren([], nextList);

    expect(next).toBe(nextList);
  });
});
