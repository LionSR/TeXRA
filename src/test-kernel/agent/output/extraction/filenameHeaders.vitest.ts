import { describe, expect, it } from 'vitest';

import { extractFilenameHeaderDocuments } from '@agent/output/extraction/filenameHeaders';

/**
 * Regression coverage for issue #6937: `sawSoleOutputChunkLabel` must be
 * reset at *every* state transition that can leave `currentName` null again,
 * not just the header-match branch. A stale `true` value lets a later,
 * unrelated fence be misread as a continuation of the sole coalesced output
 * and silently merged into it.
 *
 * All scenarios below use the single-output-file wiring
 * (`synthesisName === coalesceRepeatedName`) that `XmlOutputManager` uses for
 * agents like ocr / paper2slide that declare exactly one output file — see
 * `src/agent/output/XmlOutputManager.ts` around the `soleExpectedFile` wiring.
 */
function extract(content: string) {
  return extractFilenameHeaderDocuments(content, {
    thinkingTag: 'scratchpad',
    roundDir: '/round',
    labelFiles: ['output.tex'],
    synthesisName: 'output.tex',
    coalesceRepeatedName: 'output.tex',
    wrapperTag: 'documents',
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

  it('resets the label across a synthesized single-output document and its auto-close', () => {
    // A prose segment leaves sawSoleOutputChunkLabel live while a synthesized
    // (unlabeled) document is created and auto-closed; the call must still
    // resolve to one correctly-assembled output.tex.
    const content = [
      '```',
      '\\section{Intro}',
      '% output.tex',
      '\\begin{document}',
      'Doc1 body text.',
      '\\end{document}',
      '```',
      'Some commentary before the aside.',
      '```',
      '\\section{Second}',
      '',
      '```',
      'chunk content for coalescing',
      '```',
      'More commentary here.',
      'Continued.tex:',
      '% output.tex',
      '\\begin{document}',
      'Doc2 body text.',
      '\\end{document}',
      '```',
    ].join('\n');

    const documents = extract(content);

    expect(documents).toEqual([
      {
        name: 'output.tex',
        content: [
          '\\section{Intro}',
          '% output.tex',
          '\\begin{document}',
          'Doc1 body text.',
          '\\end{document}',
          '',
          'chunk content for coalescing',
          '',
          '\\section{Second}',
          '',
          '% output.tex',
          '\\begin{document}',
          'Doc2 body text.',
          '\\end{document}',
        ].join('\n'),
      },
    ]);
  });
});
