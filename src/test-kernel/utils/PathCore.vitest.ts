import { describe, expect, it } from 'vitest';

import { isPathWithin } from '@utils/core/pathCore';

describe('isPathWithin', () => {
  it.each([
    // A sibling directory that merely shares a string prefix is outside.
    ['/base', '/base-other/file.tex', false],
    // Parent-traversal escapes, including via backslashes.
    [
      String.raw`C:\base\child`,
      String.raw`C:\base\child\..\..\etc\passwd`,
      false,
    ],
    // A first segment that merely begins with two dots is inside the base —
    // only a whole `..` segment escapes it.
    ['/base', '/base/..notes.tex', true],
  ])('isPathWithin(%j, %j) → %s', (base, target, expected) => {
    expect(isPathWithin(base, target)).toBe(expected);
  });
});
