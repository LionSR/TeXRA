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

describe('buildReviewInstruction', () => {
  it('embeds the base, file list, and diff', () => {
    const instruction = buildReviewInstruction({
      baseDescription: 'main branch (origin/main)',
      changedFiles: ['a.tex', 'b.ts'],
      diff: 'diff --git a/a.tex b/a.tex',
      truncated: true,
    });
    expect(instruction).toContain('main branch (origin/main)');
    expect(instruction).toContain('a.tex\nb.ts');
    expect(instruction).toContain('diff --git a/a.tex b/a.tex');
    expect(instruction).toContain('report_review_issue');
    expect(instruction).toContain('truncated');
  });

  it('weaves in per-run user instructions when provided', () => {
    const focused = buildReviewInstruction({
      baseDescription: 'main',
      changedFiles: ['a.tex'],
      diff: 'x',
      truncated: false,
      userInstructions: 'Focus on error handling',
    });
    expect(focused).toContain('<reviewer-instructions>');
    expect(focused).toContain('Focus on error handling');

    const plain = buildReviewInstruction({
      baseDescription: 'main',
      changedFiles: ['a.tex'],
      diff: 'x',
      truncated: false,
    });
    expect(plain).not.toContain('reviewer-instructions');
  });
});

describe('buildFixInstruction', () => {
  it('lists each issue with location, severity, and suggestion', () => {
    const instruction = buildFixInstruction(
      [
        {
          id: '1',
          file: 'src/x.ts',
          startLine: 5,
          endLine: 7,
          severity: 'critical',
          title: 'Broken loop',
          description: 'Off-by-one in bounds.',
          suggestion: 'Use < instead of <=.',
        },
        {
          id: '2',
          file: 'a.tex',
          startLine: 2,
          endLine: 2,
          severity: 'info',
          title: 'Stale label',
          description: '',
        },
      ],
      'main branch (origin/main)',
    );
    expect(instruction).toContain('2 issues');
    expect(instruction).toContain('src/x.ts:5-7 [critical]: Broken loop');
    expect(instruction).toContain('Suggested fix: Use < instead of <=.');
    expect(instruction).toContain('a.tex:2 [info]: Stale label');
    expect(instruction).toContain('smallest change');
  });
});
