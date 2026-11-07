import { describe, expect, it } from 'vitest';

import {
  expectedDocuments,
  extractFilenameHeaderDocuments,
} from '@texra/agent/output/extraction/filenameHeaders';

/**
 * Regression coverage for issue #6937: `sawSoleOutputChunkLabel` must be
 * reset at *every* state transition that can leave `currentName` null again,
 * not just the header-match branch. A stale `true` value lets a later,
 * unrelated fence be misread as a continuation of the sole coalesced output
 * and silently merged into it.
 *
 * All scenarios below expect what a task that declares exactly one output
 * file (ocr / paper2slide) expects: that file, as the sole name.
 */
function extract(content: string) {
  return extractFilenameHeaderDocuments(content, {
    roundDir: '/round',
    expected: expectedDocuments({
      inputFiles: [],
      outputFiles: ['output.tex'],
    }),
  });
}

describe('extractFilenameHeaderDocuments — sawSoleOutputChunkLabel resets', () => {
  it('does not carry a stale sole-output-chunk label across an unrelated non-LaTeX aside fence', () => {
    // A bare "Continued.tex:" label that names no known file sets
    // sawSoleOutputChunkLabel stale-true; the unrelated ```json aside must not
    // let that flag absorb the following text into output.tex.
    const content = [
      '```',
      '% output.tex',
      '\\documentclass{article}',
      '\\begin{document}',
      'First chunk content.',
      '\\end{document}',
      '```',
      '',
      'Here is some unrelated commentary about the results.',
      '',
      'Continued.tex:',
      '```json',
      '{"key": "value"}',
      '```',
      'More unrelated text that should not be part of the doc.',
      '```',
      '\\section{Unrelated}',
      'This should not be merged into output.tex.',
      '```',
    ].join('\n');

    const documents = extract(content);

    expect(documents).toEqual([
      {
        name: 'output.tex',
        content: [
          '\\documentclass{article}',
          '\\begin{document}',
          'First chunk content.',
          '\\end{document}',
        ].join('\n'),
      },
    ]);
  });
});
