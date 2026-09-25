// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { normalizeReviewFilePath } from '@agent/review/reviewIssues';

describe('normalizeReviewFilePath', () => {
  it.each(['a/src/x.ts', 'b/src/x.ts', './src/x.ts', 'src\\x.ts'])(
    'strips diff prefixes and normalizes separators: %s',
    (input) => {
      expect(normalizeReviewFilePath(input)).toBe('src/x.ts');
    },
  );
});
