import { describe, expect, it } from 'vitest';

import { buildKpathseaSearchPath } from '@latex/texTools';
import {
  buildLatexdiffTextCommandExclusionFlag,
  LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS,
} from '@latex/latexdiff/diffCommandExecutor';

describe('latexdiff bibliography quality helpers', () => {
  it('excludes common citation commands from latexdiff text-command wrapping', () => {
    expect(buildLatexdiffTextCommandExclusionFlag()).toBe(
      `--exclude-textcmd=${LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS.join(',')}`,
    );
    expect(LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS).toContain('citep\\*?');
    expect(LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS).toContain('citet\\*?');
    expect(LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS).toContain(
      'parencite\\*?',
    );
  });

  it('prepends BIBINPUTS and BSTINPUTS paths while preserving kpathsea defaults', () => {
    expect(buildKpathseaSearchPath(['/workspace'], undefined, ':')).toBe(
      '/workspace:',
    );
    expect(buildKpathseaSearchPath(['/workspace'], '/custom', ':')).toBe(
      '/workspace:/custom:',
    );
  });

  it('uses the platform delimiter for TeX search paths', () => {
    expect(
      buildKpathseaSearchPath(['C:\\work', 'D:\\shared'], 'E:\\texmf', ';'),
    ).toBe('C:\\work;D:\\shared;E:\\texmf;');
  });

  it('omits empty TeX search paths', () => {
    expect(buildKpathseaSearchPath(['', '  '], undefined, ':')).toBeUndefined();
  });
});
