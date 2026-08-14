import { describe, expect, it } from 'vitest';

import {
  getIndentTeXNotification,
  getLatexdiffPackNotifications,
} from '@commands/latex/latexHousekeepingNotifications';
import type { LatexdiffPackResult } from '@housekeeping/packLatexdiffvc';
import type { IndentLatexResult } from '@latex/formatter/indentDirectory';

describe('latex housekeeping command notifications', () => {
  it('restores indent config and error notifications', () => {
    const missingConfig: IndentLatexResult = {
      status: 'missing-config',
      directory: '.',
      count: 0,
      configPath: '/tmp/missing.yaml',
    };
    const error = new Error('walk failed');
    const failed: IndentLatexResult = {
      status: 'error',
      directory: '.',
      count: 0,
      error,
    };

    expect(getIndentTeXNotification(missingConfig)).toEqual({
      severity: 'message',
      message: 'Formatter config file not found at /tmp/missing.yaml',
    });
    expect(getIndentTeXNotification(failed)).toEqual({
      severity: 'error',
      message: 'Error during indentation process',
      error,
    });
    expect(
      getIndentTeXNotification({
        status: 'formatted',
        directory: '.',
        count: 2,
      }),
    ).toBeUndefined();
  });

  const packCases: Array<{
    result: LatexdiffPackResult;
    expected: { severity: string; message: string } | undefined;
  }> = [
    {
      result: { status: 'no-files', inputFile: 'paper.tex' },
      expected: {
        severity: 'info',
        message: 'No LaTeX diff files found to process',
      },
    },
    {
      result: { status: 'cleaned', inputFile: 'paper.tex' },
      expected: {
        severity: 'info',
        message: 'LaTeXdiff files cleaned',
      },
    },
    {
      result: {
        status: 'packed',
        inputFile: 'paper.tex',
        outputFolder: 'Diffs/20260505_paper_HEAD',
      },
      expected: {
        severity: 'info',
        message: 'Files packed into Diffs/20260505_paper_HEAD',
      },
    },
    {
      result: { status: 'processed', inputFile: 'paper.tex' },
      expected: undefined,
    },
  ];

  it.each(packCases)(
    'restores the latexdiff pack notification for $result.status',
    ({ result, expected }) => {
      const notification = getLatexdiffPackNotifications(result);
      if (expected === undefined) {
        expect(notification).toBeUndefined();
      } else {
        expect(notification).toMatchObject(expected);
      }
    },
  );
});
