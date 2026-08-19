// Node imports
import * as path from 'node:path';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { runCompileCheck } from '@agent/implementations/flows/reflection/output/compileCheck';
import {
  createOutputState,
  ensureRoundData,
} from '@agent/implementations/flows/reflection/output/outputState';
import type { CompileLatex2PdfResult } from '@latex/texTools';
import type { ExecutionId, FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';

// Local file imports
import {
  compileContext,
  initLatexPlatform,
  outputFile,
  runDir,
} from './compileCheckTestUtils';

interface FakeCompileOptions {
  outputDirectory?: string;
}

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn(
    async (
      _location: FileLocation,
      _options?: FakeCompileOptions,
    ): Promise<CompileLatex2PdfResult> => ({ ok: true }),
  ),
  hasLatexCompiler: vi.fn(async () => true),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@latex/latexToolchain', () => ({
  hasLatexCompiler: mocks.hasLatexCompiler,
}));

/** Seeds a single round-0 `main.tex` output -- the common single-file case. */
function seedMainTexOutput(executionId: ExecutionId) {
  const outputState = createOutputState();
  ensureRoundData(outputState, 0).outputs = [
    outputFile(executionId, path.join('r0', 'main.tex'), 'main.tex', 0),
  ];
  return outputState;
}

const COMPILABLE_TEX =
  '\\documentclass{article}\\begin{document}Hi\\end{document}';

/** Seeds a compilable round-0 `main.tex` on the fake FS. */
async function seedCompilableMainTex(executionId: ExecutionId): Promise<void> {
  await initLatexPlatform({
    [path.join(runDir(executionId), 'r0', 'main.tex')]: COMPILABLE_TEX,
  });
}

type CompileCheckResult = Awaited<ReturnType<typeof runCompileCheck>>;

/** Requires a failed compile result and returns its combined log excerpt. */
function failedExcerpt(result: CompileCheckResult): string {
  if (result.compileResult?.status !== 'failed') {
    expect.unreachable('expected a failed compile result');
  }
  return result.compileResult.logExcerpt;
}

describe('runCompileCheck', () => {
  beforeEach(() => {
    mocks.compileLatex2Pdf.mockReset().mockResolvedValue({ ok: true });
    mocks.hasLatexCompiler.mockReset().mockResolvedValue(true);
  });

  it('counts a per-file exception as a failure, never a silent skip', async () => {
    const executionId = 'compile-exception';
    // No file is seeded at the tex path, so AbsoluteFS.read throws ENOENT
    // before compileLatex2Pdf is ever invoked.
    await initLatexPlatform({});

    const outputState = seedMainTexOutput(executionId);

    const result = await runCompileCheck(
      compileContext(executionId, outputState),
      0,
    );

    expect(mocks.compileLatex2Pdf).not.toHaveBeenCalled();
    expect(result.compileResult?.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].displayName).toBe('main.tex');
    expect(failedExcerpt(result)).toContain(
      'Compile check errored for main.tex',
    );

    // The synthetic excerpt is persisted like a real failure so it stays
    // discoverable on disk, not just in-memory.
    const persisted = await AbsoluteFS.read(
      result.failures[0].log.absolutePath,
    );
    expect(persisted).toContain('Compile check errored for main.tex');
  });

  it('treats a fragment with no \\documentclass as a graceful skip, not a failure', async () => {
    const executionId = 'compile-fragment';
    const texPath = path.join(runDir(executionId), 'r0', 'chunk.tex');
    await initLatexPlatform({
      [texPath]: '\\section{Included fragment}\n',
    });

    const outputState = createOutputState();
    ensureRoundData(outputState, 0).outputs = [
      outputFile(executionId, path.join('r0', 'chunk.tex'), 'chunk.tex', 0),
    ];

    const result = await runCompileCheck(
      compileContext(executionId, outputState),
      0,
    );

    expect(mocks.compileLatex2Pdf).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(0);
    expect(result.compileResult?.status).toBe('ok');
  });

  // The 200-line raw-tail extraction itself now lives in compileLatex2Pdf
  // (src/latex/texTools.ts), covered by TexTools.vitest.ts. This test proves
  // the other half of issue #7079's fix: whatever `logTail` compileCheck
  // receives from the shared { ok, logTail } return shape is threaded
  // through, unmodified, into the persisted failure excerpt -- it is not
  // read from disk a second time.
  it('sources the failing log tail from compileLatex2Pdf, not a separate disk read', async () => {
    const executionId = 'compile-tail-passthrough';
    await seedCompilableMainTex(executionId);

    // Zero-padded so containment checks below can't be fooled by numeric
    // substrings (e.g. "L0001" would otherwise match inside "L00010").
    const logTail = Array.from(
      { length: 200 },
      (_, i) => `L${String(i + 51).padStart(4, '0')}`,
    ).join('\n');
    mocks.compileLatex2Pdf.mockResolvedValue({ ok: false, logTail });

    const result = await runCompileCheck(
      compileContext(executionId, seedMainTexOutput(executionId)),
      0,
    );

    const excerpt = failedExcerpt(result);
    expect(excerpt).toContain('L0051');
    expect(excerpt).toContain('L0250');
    expect(excerpt).not.toContain('L0050');
  });

  it('truncates the combined excerpt to the last 12000 characters', async () => {
    const executionId = 'compile-char-truncation';
    await seedCompilableMainTex(executionId);

    // 150 lines * 101 chars (100 + newline) stays under the 200-line cap but
    // comfortably exceeds the 12000-character combined-excerpt limit once
    // wrapped with the "Compile check failed for..." header. Zero-padded
    // markers avoid numeric-substring false matches in the assertions below.
    const longLine = 'x'.repeat(100);
    const lines = Array.from(
      { length: 150 },
      (_, i) => `${longLine}-END${String(i + 1).padStart(4, '0')}`,
    );
    mocks.compileLatex2Pdf.mockResolvedValue({
      ok: false,
      logTail: lines.join('\n'),
    });

    const result = await runCompileCheck(
      compileContext(executionId, seedMainTexOutput(executionId)),
      0,
    );

    const excerpt = failedExcerpt(result);
    expect(excerpt.startsWith('[truncated to last 12000 characters]')).toBe(
      true,
    );
    expect(excerpt).toContain('END0150');
    expect(excerpt).not.toContain('END0001');
  });

  it('clears a stale failure log once a later attempt at the same round succeeds', async () => {
    const executionId = 'compile-stale-log';
    await seedCompilableMainTex(executionId);

    mocks.compileLatex2Pdf.mockResolvedValueOnce({
      ok: false,
      logTail: 'stale failure log',
    });

    const outputState = seedMainTexOutput(executionId);
    const ctx = compileContext(executionId, outputState);

    const firstResult = await runCompileCheck(ctx, 0);
    expect(firstResult.compileResult?.status).toBe('failed');
    const logLocation = firstResult.failures[0].log;
    await expect(AbsoluteFS.read(logLocation.absolutePath)).resolves.toContain(
      'Compile check failed for main.tex',
    );

    // Re-run the same round (e.g. after a repaired retry); this time the
    // compile succeeds.
    mocks.compileLatex2Pdf.mockResolvedValueOnce({ ok: true });
    const secondResult = await runCompileCheck(ctx, 0);
    expect(secondResult.compileResult?.status).toBe('ok');

    // The stale failure log from the first attempt must be gone -- otherwise
    // "no compile/*.log = success" would still find leftover failure evidence.
    await expect(AbsoluteFS.read(logLocation.absolutePath)).rejects.toThrow();
  });

  it('gives colliding-after-sanitization paths distinct, non-clobbering log slots', async () => {
    const executionId = 'compile-collision';
    // Both sanitize (non [a-zA-Z0-9._-] -> "_") to the same "dir_a_b.tex":
    // "dir/a:b.tex" (":" -> "_") and "dir/a_b.tex" ("/" -> "_", "_" already
    // allowed). Without a disambiguating hash, the second file's log write
    // would silently replace the first's.
    const pathA = path.join('r0', 'dir', 'a:b.tex');
    const pathB = path.join('r0', 'dir', 'a_b.tex');
    const texPathA = path.join(runDir(executionId), pathA);
    const texPathB = path.join(runDir(executionId), pathB);
    await initLatexPlatform({
      [texPathA]: '\\documentclass{article}\\begin{document}A\\end{document}',
      [texPathB]: '\\documentclass{article}\\begin{document}B\\end{document}',
    });

    mocks.compileLatex2Pdf.mockImplementation(async (location) => ({
      ok: false,
      logTail: `LOG MARKER FOR ${location.absolutePath}`,
    }));

    const outputState = createOutputState();
    ensureRoundData(outputState, 0).outputs = [
      outputFile(executionId, pathA, 'a:b.tex', 0),
      outputFile(executionId, pathB, 'a_b.tex', 0),
    ];

    const result = await runCompileCheck(
      compileContext(executionId, outputState),
      0,
    );

    expect(result.failures).toHaveLength(2);
    const [failureA, failureB] = result.failures;
    // Distinct log slots despite the identical sanitized basename.
    expect(failureA.logRelativePath).not.toBe(failureB.logRelativePath);
    expect(failureA.log.absolutePath).not.toBe(failureB.log.absolutePath);

    const persistedA = await AbsoluteFS.read(failureA.log.absolutePath);
    const persistedB = await AbsoluteFS.read(failureB.log.absolutePath);
    expect(persistedA).toContain(`LOG MARKER FOR ${texPathA}`);
    expect(persistedA).not.toContain(texPathB);
    expect(persistedB).toContain(`LOG MARKER FOR ${texPathB}`);
    expect(persistedB).not.toContain(texPathA);
  });

  it('records a resolvable log path through the outer backstop when compileOne throws before its own try/catch', async () => {
    // Simulates a bug in compileOne's own pre-compile bookkeeping (path/hash
    // computation), which runs before compileOne's internal try/catch and so
    // can only be caught by runCompileCheck's outer per-file backstop.
    const executionId = 'compile-outer-backstop';
    await seedCompilableMainTex(executionId);

    const schemasModule = await import('@shared/schemas');
    const comparablePathSpy = vi
      .spyOn(schemasModule, 'fileLocationDisplayPath')
      .mockImplementationOnce(() => {
        throw new Error('simulated bookkeeping bug');
      });

    try {
      const relativePath = path.join('r0', 'main.tex');
      const outputState = seedMainTexOutput(executionId);

      const result = await runCompileCheck(
        compileContext(executionId, outputState),
        0,
      );

      expect(mocks.compileLatex2Pdf).not.toHaveBeenCalled();
      expect(result.compileResult?.status).toBe('failed');
      expect(result.failures).toHaveLength(1);
      // The second (uninstrumented) call to fileLocationDisplayPath, made from the
      // backstop itself, resolves normally -- so the failure gets a real,
      // resolvable path instead of a broken placeholder string.
      expect(result.failures[0].logRelativePath).toBe(relativePath);
      expect(result.failures[0].log).toEqual(
        outputFile(executionId, relativePath, 'main.tex', 0).location,
      );
    } finally {
      comparablePathSpy.mockRestore();
    }
  });
});
