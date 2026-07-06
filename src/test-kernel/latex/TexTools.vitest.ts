// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { installPlatform } from '@test/support/setupPlatform';

// Local imports - latex
import { compileLatex2Pdf } from '@latex/texTools';

// Local imports - shared
import type { ExecResult } from '@shared/schemas/opResults';

// Local imports - file utilities
import { flexibleFS, pathToLocation } from '@utils/files';

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
    await flexibleFS.ensureDir(pathToLocation(outputDirectory));
    await flexibleFS.write(
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
