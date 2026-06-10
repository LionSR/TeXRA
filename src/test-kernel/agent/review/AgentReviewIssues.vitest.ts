// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  buildFixInstruction,
  buildReviewPrompts,
  normalizeReviewFilePath,
  parseReviewResponse,
} from '@agent/review/reviewIssues';

describe('parseReviewResponse', () => {
  it('parses a fenced JSON array and assigns ids', () => {
    const response = [
      'Here is my review:',
      '```json',
      JSON.stringify([
        {
          file: 'src/app.ts',
          startLine: 12,
          endLine: 14,
          severity: 'critical',
          title: 'Null deref',
          description: 'foo may be undefined',
          suggestion: 'guard it',
        },
      ]),
      '```',
    ].join('\n');

    const issues = parseReviewResponse(response);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: 'src/app.ts',
      startLine: 12,
      endLine: 14,
      severity: 'critical',
      title: 'Null deref',
      description: 'foo may be undefined',
      suggestion: 'guard it',
    });
    expect(issues[0].id).toBeTruthy();
  });

  it('parses a bare array and an issues-wrapped object', () => {
    const bare = parseReviewResponse(
      '[{"file":"a.tex","startLine":3,"severity":"info","title":"T","description":"d"}]',
    );
    expect(bare).toHaveLength(1);
    expect(bare[0].endLine).toBe(3);

    const wrapped = parseReviewResponse(
      '{"issues":[{"file":"a.tex","startLine":3,"severity":"info","title":"T","description":"d"}]}',
    );
    expect(wrapped).toHaveLength(1);
  });

  it('salvages valid entries, defaults bad severities and lines, and clamps endLine', () => {
    const issues = parseReviewResponse(
      JSON.stringify([
        { startLine: 1, title: 'missing file' },
        {
          file: 'b/x.ts',
          startLine: -4,
          endLine: 2,
          severity: 'catastrophic',
          title: 'Odd entry',
          description: 'desc',
        },
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: 'x.ts',
      startLine: 1,
      endLine: 2,
      severity: 'warning',
    });
  });

  it('returns an empty list for prose or malformed JSON', () => {
    expect(parseReviewResponse('No issues found, looks good!')).toEqual([]);
    expect(parseReviewResponse('```json\n[{"file": broken]\n```')).toEqual([]);
  });
});

describe('normalizeReviewFilePath', () => {
  it('strips diff prefixes and normalizes separators', () => {
    expect(normalizeReviewFilePath('a/src/x.ts')).toBe('src/x.ts');
    expect(normalizeReviewFilePath('b/src/x.ts')).toBe('src/x.ts');
    expect(normalizeReviewFilePath('./src/x.ts')).toBe('src/x.ts');
    expect(normalizeReviewFilePath('src\\x.ts')).toBe('src/x.ts');
  });
});

describe('buildReviewPrompts', () => {
  it('embeds base, file list, and diff; thorough mode appends file contents', () => {
    const { systemPrompt, userPrompt } = buildReviewPrompts({
      baseDescription: 'main branch (origin/main)',
      changedFiles: ['a.tex', 'b.ts'],
      diff: 'diff --git a/a.tex b/a.tex',
      approach: 'thorough',
      extraContext: '<file path="a.tex">content</file>',
    });
    expect(systemPrompt).toContain('THOROUGH');
    expect(userPrompt).toContain('<base>main branch (origin/main)</base>');
    expect(userPrompt).toContain('a.tex\nb.ts');
    expect(userPrompt).toContain('diff --git a/a.tex b/a.tex');
    expect(userPrompt).toContain('<file-contents>');

    const quick = buildReviewPrompts({
      baseDescription: 'main',
      changedFiles: ['a.tex'],
      diff: 'x',
      approach: 'quick',
    });
    expect(quick.systemPrompt).toContain('QUICK');
    expect(quick.userPrompt).not.toContain('<file-contents>');
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
    expect(instruction).toContain('src/x.ts:5-7 [critical] — Broken loop');
    expect(instruction).toContain('Suggested fix: Use < instead of <=.');
    expect(instruction).toContain('a.tex:2 [info] — Stale label');
    expect(instruction).toContain('smallest change');
  });
});
