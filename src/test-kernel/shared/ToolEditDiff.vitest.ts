import { describe, expect, it } from 'vitest';

import { firstChangedLine } from '@shared/approval/toolEditDiff';

describe('tool edit diff helpers', () => {
  it('returns null when contents are identical', () => {
    expect(firstChangedLine('alpha\nbeta\n', 'alpha\nbeta\n')).toBeNull();
  });

  it('locates an inserted line at the insertion position', () => {
    expect(firstChangedLine('alpha\ngamma\n', 'alpha\nbeta\ngamma\n')).toBe(1);
  });

  it('locates a deletion after equal text at the deleted line', () => {
    expect(firstChangedLine('alpha\nbeta\ngamma\n', 'alpha\ngamma\n')).toBe(1);
  });

  it('locates a substitution after equal text at the substituted line', () => {
    expect(
      firstChangedLine('alpha\nbeta\ngamma\n', 'alpha\nBETTA\ngamma\n'),
    ).toBe(1);
  });
});
