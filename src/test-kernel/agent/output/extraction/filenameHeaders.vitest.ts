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
    // 1. `% output.tex` establishes the sole coalesced output.
    // 2. A bare label ("Continued.tex:") that doesn't name a known file sets
    //    sawSoleOutputChunkLabel = true, signaling "the next fence may be a
    //    continuation of the sole output".
    // 3. A ```json aside appears next — it fails the isLatexMarkdownFence
    //    gate, so it is prose/example content, not a continuation. Before the
    //    fix, entering this branch left sawSoleOutputChunkLabel stale-true.
    // 4. The aside's own (bare) closing fence is then evaluated fresh against
    //    the sole-output-chunk gate: with the stale flag, it is
    //    misinterpreted as *opening* a new coalesced chunk, silently
    //    absorbing the unrelated text that follows into output.tex.
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
    // Reproduces the full chain the issue describes: a prose segment leaves
    // sawSoleOutputChunkLabel stale-true, then a *synthesized* (unlabeled
    // LaTeX prefix) document is created and auto-closed while that flag is
    // live, exercising both the synthesis branch (currentName =
    // synthesisName) and its auto-close path. The whole call must still
    // resolve to a single, correctly-assembled output.tex with no corrupted
    // or duplicated documents.
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
