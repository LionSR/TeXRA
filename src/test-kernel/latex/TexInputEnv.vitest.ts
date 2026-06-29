// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - latex
import { buildLatexInputEnv, buildLatexSearchParts } from '@latex/texTools';

const D = path.delimiter;

describe('buildLatexInputEnv', () => {
  it('omits TEXINPUTS when only the implicit "." part is present and none inherited', () => {
    const env = buildLatexInputEnv(['.'], [], {});
    expect(env.TEXINPUTS).toBeUndefined();
    expect(env.BIBINPUTS).toBeUndefined();
    expect(env.BSTINPUTS).toBeUndefined();
  });

  it('prepends workspace and TikZ dirs onto inherited TEXINPUTS', () => {
    const env = buildLatexInputEnv(['.', '/ws', '/tikz'], ['/ws'], {
      TEXINPUTS: '/inherited',
      BIBINPUTS: '/bib',
      BSTINPUTS: '/bst',
    });
    expect(env.TEXINPUTS).toBe(`.${D}/ws${D}/tikz${D}/inherited${D}`);
    expect(env.BIBINPUTS).toBe(`/ws${D}/bib${D}`);
    expect(env.BSTINPUTS).toBe(`/ws${D}/bst${D}`);
  });

  it('emits TEXINPUTS from inherited value alone even without extra parts', () => {
    const env = buildLatexInputEnv(['.'], [], { TEXINPUTS: '/inherited' });
    expect(env.TEXINPUTS).toBe(`.${D}/inherited${D}`);
  });

  it('does not read the ambient process environment when env is injected', () => {
    const env = buildLatexInputEnv(['.', '/ws'], ['/ws'], {});
    expect(env.TEXINPUTS).toBe(`.${D}/ws${D}`);
    expect(env.BIBINPUTS).toBe(`/ws${D}`);
  });
});

describe('buildLatexSearchParts', () => {
  it('puts the document dir first, then extra source dirs, then workspace/tikz', () => {
    const { texInputParts, bibSearchParts } = buildLatexSearchParts({
      documentDir: '/run/diff/r1',
      extraInputDirs: ['/ws/Draft/LeanMPSPaper'],
      workspacePath: '/ws',
      tikzInputDirectory: '/tikz',
    });
    // Source dirs (document + extra) rank above the workspace root so a revised
    // sibling in run storage wins over the original-source fallback.
    expect(texInputParts).toEqual([
      '.',
      '/run/diff/r1',
      '/ws/Draft/LeanMPSPaper',
      '/ws',
      '/tikz',
    ]);
    // Bibliography search drops "." and the TikZ dir.
    expect(bibSearchParts).toEqual([
      '/run/diff/r1',
      '/ws/Draft/LeanMPSPaper',
      '/ws',
    ]);
  });

  it('still emits the document dir when no workspace, tikz, or extras are given', () => {
    const { texInputParts, bibSearchParts } = buildLatexSearchParts({
      documentDir: '/run/r0/Draft/LeanMPSPaper',
      workspacePath: null,
    });
    expect(texInputParts).toEqual(['.', '/run/r0/Draft/LeanMPSPaper']);
    expect(bibSearchParts).toEqual(['/run/r0/Draft/LeanMPSPaper']);
  });

  it('ignores blank tikz dirs', () => {
    const { texInputParts } = buildLatexSearchParts({
      documentDir: '/doc',
      workspacePath: '/ws',
      tikzInputDirectory: '   ',
    });
    expect(texInputParts).toEqual(['.', '/doc', '/ws']);
  });
});
