// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - latex
import { buildLatexInputEnv } from '@latex/texTools';

const D = path.delimiter;

describe('buildLatexInputEnv', () => {
  it('omits TEXINPUTS when only the implicit "." part is present and none inherited', () => {
    const env = buildLatexInputEnv(['.'], [], {});
    expect(env.TEXINPUTS).toBeUndefined();
    expect(env.BIBINPUTS).toBeUndefined();
    expect(env.BSTINPUTS).toBeUndefined();
  });

  it('prepends workspace and TikZ dirs onto inherited TEXINPUTS', () => {
    const env = buildLatexInputEnv(
      ['.', '/ws', '/tikz'],
      ['/ws'],
      { TEXINPUTS: '/inherited', BIBINPUTS: '/bib', BSTINPUTS: '/bst' },
    );
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
