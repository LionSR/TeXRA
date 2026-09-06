import { describe, expect, it } from 'vitest';

import { getIndentTeXNotification } from '@commands/latex/latexHousekeepingNotifications';
import {
  latexdiffPackMessage,
  type LatexdiffPackResult,
} from '@housekeeping/packLatexdiffvc';
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
    expected: string | undefined;
  }> = [
    {
      result: { status: 'no-files', inputFile: 'paper.tex' },
      expected: 'No LaTeX diff files found to process',
    },
    {
      result: { status: 'cleaned', inputFile: 'paper.tex' },
      expected: 'LaTeXdiff files cleaned',
    },
    {
      result: {
        status: 'packed',
        inputFile: 'paper.tex',
        outputFolder: 'Diffs/20260505_paper_HEAD',
      },
      expected: 'Files packed into Diffs/20260505_paper_HEAD',
    },
    {
      result: { status: 'processed', inputFile: 'paper.tex' },
      expected: undefined,
    },
  ];

  it.each(packCases)(
    'restores the latexdiff pack message for $result.status',
    ({ result, expected }) => {
      expect(latexdiffPackMessage(result)).toBe(expected);
    },
  );
});
