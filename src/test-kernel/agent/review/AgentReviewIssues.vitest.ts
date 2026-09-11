// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  buildFixInstruction,
  buildReviewInstruction,
  createReviewIssue,
  normalizeReviewFilePath,
} from '@agent/review/reviewIssues';

describe('createReviewIssue', () => {
  it('assigns an id, normalizes the path, and keeps the reported fields', () => {
    const issue = createReviewIssue({
      file: 'b/src/app.ts',
      startLine: 12,
      endLine: 14,
      severity: 'critical',
      title: ' Null deref ',
      description: ' foo may be undefined ',
      suggestion: 'guard it',
    });
    expect(issue).toMatchObject({
      file: 'src/app.ts',
      startLine: 12,
      endLine: 14,
      severity: 'critical',
      title: 'Null deref',
      description: 'foo may be undefined',
      suggestion: 'guard it',
    });
    expect(issue.id).toBeTruthy();
  });

  it('clamps line ranges and drops empty suggestions', () => {
    const issue = createReviewIssue({
      file: 'x.ts',
      startLine: -4,
      endLine: 2,
      severity: 'warning',
      title: 'Odd entry',
      description: 'desc',
      suggestion: '  ',
    });
    expect(issue).toMatchObject({
      startLine: 1,
      endLine: 2,
      suggestion: undefined,
    });

    const single = createReviewIssue({
      file: 'x.ts',
      startLine: 7,
      severity: 'info',
      title: 'T',
      description: 'd',
    });
    expect(single.endLine).toBe(7);
  });
});

describe('normalizeReviewFilePath', () => {
  it.each(['a/src/x.ts', 'b/src/x.ts', './src/x.ts', 'src\\x.ts'])(
    'strips diff prefixes and normalizes separators: %s',
    (input) => {
      expect(normalizeReviewFilePath(input)).toBe('src/x.ts');
    },
  );
});
