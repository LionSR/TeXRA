// Suites for @latex/texTools (compile wrapper + TEXINPUTS env builders).

import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLatexInputEnv,
  buildLatexSearchParts,
  compileLatex2Pdf,
} from '@latex/texTools';
import type { ExecResult } from '@shared/schemas/opResults';
import { installPlatform } from '@test/support/setupPlatform';
import { FlexibleFS, pathToLocation } from '@utils/files';

// ---------------------------------------------------------------------------
// TexTools
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

vi.mock('@utils/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@utils/system')>();
  return { ...actual, runToolWithCheck: mocks.runToolWithCheck };
});

const workspacePath = '/workspace';

function execResult(success: boolean): ExecResult {
  return { success, stdout: '', stderr: '', exitCode: success ? 0 : 1 };
}

// Issue #7079: compileLatex2Pdf used to return a bare boolean, so every
// caller besides compileCheck.readLogTail swallowed the compile log on
// failure. These tests exercise the real production code (only the
// subprocess call is mocked) to prove the { ok, logTail } shape and the
// 200-line raw-tail extraction it now owns.
describe('compileLatex2Pdf structured return', () => {
  beforeEach(async () => {
    mocks.runToolWithCheck.mockReset();
    await installPlatform({ workspacePath });
  });

  it('returns { ok: true } with no logTail on a successful compile', async () => {
    mocks.runToolWithCheck.mockResolvedValue(execResult(true));

    const result = await compileLatex2Pdf(
      pathToLocation(path.join(workspacePath, 'main.tex')),
      { outputDirectory: path.join(workspacePath, 'build') },
    );

    expect(result).toEqual({ ok: true });
  });

  it('surfaces the last 200 lines of the engine log as logTail on a failed compile', async () => {
    mocks.runToolWithCheck.mockResolvedValue(execResult(false));

    const outputDirectory = path.join(workspacePath, 'build');
    // Zero-padded so containment checks below can't be fooled by numeric
    // substrings (e.g. "L0001" would otherwise match inside "L00010").
    const totalLines = 250;
    const lines = Array.from(
      { length: totalLines },
      (_, i) => `L${String(i + 1).padStart(4, '0')}`,
    );
    await FlexibleFS.ensureDir(pathToLocation(outputDirectory));
    await FlexibleFS.write(
      pathToLocation(path.join(outputDirectory, 'main.log')),
      lines.join('\n'),
    );

    const result = await compileLatex2Pdf(
      pathToLocation(path.join(workspacePath, 'main.tex')),
      { outputDirectory },
    );

    if (result.ok) throw new Error('expected a failed compile');
    // Last 200 of 250 lines survive: L0051 .. L0250.
    expect(result.logTail).toContain('L0051');
    expect(result.logTail).toContain('L0250');
    expect(result.logTail).not.toContain('L0050');
    expect(result.logTail).not.toContain('L0001');
  });

  it.each(['.ltx', '.latex'])(
    'finds the engine log for a %s source, not just .tex',
    async (ext) => {
      mocks.runToolWithCheck.mockResolvedValue(execResult(false));

      const outputDirectory = path.join(workspacePath, `build${ext}`);
      await FlexibleFS.ensureDir(pathToLocation(outputDirectory));
      // The engine always names the log after the source with ITS OWN
      // extension stripped, regardless of which LaTeX extension was used.
      await FlexibleFS.write(
        pathToLocation(path.join(outputDirectory, 'main.log')),
        'engine log content',
      );

      const result = await compileLatex2Pdf(
        pathToLocation(path.join(workspacePath, `main${ext}`)),
        { outputDirectory },
      );

      if (result.ok) throw new Error('expected a failed compile');
      expect(result.logTail).toContain('engine log content');
      expect(result.logTail).not.toContain('no LaTeX log at');
    },
  );

  it('falls back to a discoverable placeholder when no engine log exists on disk', async () => {
    mocks.runToolWithCheck.mockResolvedValue(execResult(false));

    const result = await compileLatex2Pdf(
      pathToLocation(path.join(workspacePath, 'missing.tex')),
      { outputDirectory: path.join(workspacePath, 'build-missing') },
    );

    if (result.ok) throw new Error('expected a failed compile');
    expect(result.logTail).toContain('no LaTeX log at');
  });

  it('surfaces the exception message as logTail when the compiler invocation throws', async () => {
    mocks.runToolWithCheck.mockRejectedValue(
      new Error('boom: pdflatex crashed'),
    );

    const result = await compileLatex2Pdf(
      pathToLocation(path.join(workspacePath, 'main.tex')),
      { outputDirectory: path.join(workspacePath, 'build') },
    );

    if (result.ok) throw new Error('expected a failed compile');
    expect(result.logTail).toContain('boom: pdflatex crashed');
  });
});

// ---------------------------------------------------------------------------
// TexInputEnv
// ---------------------------------------------------------------------------

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
  it('ranks document + extra source dirs ahead of cwd, workspace, and tikz', () => {
    const { texInputParts, bibSearchParts } = buildLatexSearchParts({
      documentDir: '/run/diff/r1',
      extraInputDirs: ['/ws/Draft/LeanMPSPaper'],
      workspacePath: '/ws',
      tikzInputDirectory: '/tikz',
    });
    // Source dirs precede "." (cwd = workspace root) so a subfolder document's
    // relative \input resolves against its own tree; the document dir precedes
    // the extra source dir so a revised sibling beats the original fallback.
    expect(texInputParts).toEqual([
      '/run/diff/r1',
      '/ws/Draft/LeanMPSPaper',
      '.',
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
    expect(texInputParts).toEqual(['/run/r0/Draft/LeanMPSPaper', '.']);
    expect(bibSearchParts).toEqual(['/run/r0/Draft/LeanMPSPaper']);
  });

  it('ignores blank tikz dirs', () => {
    const { texInputParts } = buildLatexSearchParts({
      documentDir: '/doc',
      workspacePath: '/ws',
      tikzInputDirectory: '   ',
    });
    expect(texInputParts).toEqual(['/doc', '.', '/ws']);
  });
});
