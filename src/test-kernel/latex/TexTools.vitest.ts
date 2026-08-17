import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEX_COMMANDS_CHANNEL } from '@latex/latexLogging';
import {
  buildKpathseaSearchPath,
  buildLatexInputEnv,
  buildLatexSearchParts,
  compileLatex2Pdf,
} from '@latex/texTools';
import * as logger from '@logger/logUtils';
import type { ExecResult } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, runToolWithCheck: mocks.runToolWithCheck };
});

const workspacePath = '/workspace';

function execResult(success: boolean): ExecResult {
  return {
    success,
    stdout: '',
    stderr: '',
    timedOut: false,
    exitCode: success ? 0 : 1,
  };
}

function compile(
  sourceFile = 'main.tex',
  outputDirectory = path.join(workspacePath, 'build'),
): ReturnType<typeof compileLatex2Pdf> {
  return compileLatex2Pdf(
    pathToLocation(path.join(workspacePath, sourceFile)),
    {
      outputDirectory,
    },
  );
}

function failedLogTail(
  result: Awaited<ReturnType<typeof compileLatex2Pdf>>,
): string {
  if (result.ok) throw new Error('expected a failed compile');
  return result.logTail;
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

    const result = await compile();

    expect(result).toEqual({ ok: true });
  });

  it('surfaces the last 200 lines of the engine log as logTail on a failed compile', async () => {
    mocks.runToolWithCheck.mockResolvedValue(execResult(false));

    const outputDirectory = path.join(workspacePath, 'build');
    // Zero-padded so containment checks below can't be fooled by numeric
    // substrings (e.g. "L0001" would otherwise match inside "L00010").
    const lines = Array.from(
      { length: 250 },
      (_, i) => `L${String(i + 1).padStart(4, '0')}`,
    );
    await AbsoluteFS.ensureDir(outputDirectory);
    await AbsoluteFS.write(
      path.join(outputDirectory, 'main.log'),
      lines.join('\n'),
    );

    const logTail = failedLogTail(await compile());

    // Last 200 of 250 lines survive: L0051 .. L0250.
    expect(logTail).toContain('L0051');
    expect(logTail).toContain('L0250');
    expect(logTail).not.toContain('L0050');
    expect(logTail).not.toContain('L0001');
  });

  it('finds the engine log for a .ltx source, not just .tex', async () => {
    mocks.runToolWithCheck.mockResolvedValue(execResult(false));

    const outputDirectory = path.join(workspacePath, 'build.ltx');
    await AbsoluteFS.ensureDir(outputDirectory);
    // The engine always names the log after the source with ITS OWN
    // extension stripped, regardless of which LaTeX extension was used.
    await AbsoluteFS.write(
      path.join(outputDirectory, 'main.log'),
      'engine log content',
    );

    const logTail = failedLogTail(await compile('main.ltx', outputDirectory));

    expect(logTail).toContain('engine log content');
    expect(logTail).not.toContain('no LaTeX log at');
  });

  it('falls back to a discoverable placeholder when no engine log exists on disk', async () => {
    mocks.runToolWithCheck.mockResolvedValue(execResult(false));

    const logTail = failedLogTail(
      await compile('missing.tex', path.join(workspacePath, 'build-missing')),
    );

    expect(logTail).toContain('no LaTeX log at');
  });

  it('surfaces the exception message as logTail when the compiler invocation throws', async () => {
    mocks.runToolWithCheck.mockRejectedValue(
      new Error('boom: pdflatex crashed'),
    );

    const logTail = failedLogTail(await compile());

    expect(logTail).toContain('boom: pdflatex crashed');
  });
});

// #10635: compileLatex2Pdf resolves its logger per call from the threaded
// channel option (defaulting to the module channel) — a logger-namespace spy
// must observe the resolved channel.
describe('compileLatex2Pdf logger seam', () => {
  beforeEach(async () => {
    mocks.runToolWithCheck.mockReset();
    await installPlatform({ workspacePath });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns on the module channel when latexmk is missing and pdflatex takes over', async () => {
    mocks.runToolWithCheck
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(execResult(true));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await compile();

    expect(result).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(
      LATEX_COMMANDS_CHANNEL,
      expect.stringContaining('latexmk not found'),
    );
  });

  it('resolves the channel from the threaded option when one is supplied', async () => {
    mocks.runToolWithCheck
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(execResult(true));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await compileLatex2Pdf(
      pathToLocation(path.join(workspacePath, 'main.tex')),
      {
        channel: 'pinnedCompile',
        outputDirectory: path.join(workspacePath, 'build'),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(
      'pinnedCompile',
      expect.stringContaining('latexmk not found'),
    );
    expect(
      warn.mock.calls.filter(([channel]) => channel === LATEX_COMMANDS_CHANNEL),
    ).toHaveLength(0);
  });

  it('logs a throwing compiler invocation at error level on the resolved channel', async () => {
    mocks.runToolWithCheck.mockRejectedValue(
      new Error('boom: pdflatex crashed'),
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const result = await compile();

    expect(result.ok).toBe(false);
    expect(error).toHaveBeenCalledWith(
      LATEX_COMMANDS_CHANNEL,
      expect.stringContaining('Error compiling LaTeX: boom: pdflatex crashed'),
    );
  });
});

const D = path.delimiter;

describe('buildKpathseaSearchPath', () => {
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
