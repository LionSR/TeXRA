import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LATEX_COMMANDS_CHANNEL } from '@latex/latexLogging';
import { compileLatex2Pdf, type CompileLatex2PdfResult } from '@latex/texTools';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { ExecResult } from '@shared/schemas';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { fakePath } from '@test/support/FakePlatform';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { pathToLocationIn } from '@utils/files/fileLocation';

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, runToolWithCheck: mocks.runToolWithCheck };
});

const workspacePath = fakePath('workspace');

function execResult(success: boolean): ExecResult {
  return {
    success,
    stdout: '',
    stderr: '',
    timedOut: false,
    exitCode: success ? 0 : 1,
  };
}

/** Compile over the installed host's roots, as a session would hand them. */
function compile(
  sourceFile = 'main.tex',
  outputDirectory = path.join(workspacePath, 'build'),
): Effect.Effect<CompileLatex2PdfResult> {
  const roots = testWorkspaceRoots();
  return compileLatex2Pdf(
    pathToLocationIn(roots.workspace, path.join(workspacePath, sourceFile)),
    roots,
    { outputDirectory },
  ).pipe(Effect.provide(rootedFsLayer(roots)));
}

/** Seed an engine log on the real filesystem. */
function writeLog(outputDirectory: string, content: string) {
  return Effect.promise(async () => {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'main.log'), content);
  });
}

function failedLogTail(result: CompileLatex2PdfResult): string {
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

  it.live(
    'returns { ok: true } with the engine PDF path and no logTail on success',
    () =>
      Effect.gen(function* () {
        mocks.runToolWithCheck.mockReturnValue(
          Effect.succeed(execResult(true)),
        );

        const result = yield* compile();

        expect(result).toEqual({
          ok: true,
          pdfPath: path.join(workspacePath, 'build', 'main.pdf'),
        });
        // The engine runs in the session's workspace root, with the
        // kpathsea overrides ranking the document's own directory ahead of
        // the compiler's cwd (".") and the workspace root behind both.
        const D = path.delimiter;
        expect(mocks.runToolWithCheck).toHaveBeenCalledWith(
          'latexmk',
          expect.any(Array),
          expect.objectContaining({
            cwd: workspacePath,
            env: expect.objectContaining({
              TEXINPUTS: expect.stringContaining(
                `${workspacePath}${D}.${D}${workspacePath}${D}`,
              ),
            }),
          }),
        );
      }),
  );

  it.live(
    'surfaces the last 200 lines of the engine log as logTail on a failed compile',
    () =>
      Effect.gen(function* () {
        mocks.runToolWithCheck.mockReturnValue(
          Effect.succeed(execResult(false)),
        );

        const outputDirectory = path.join(workspacePath, 'build');
        // Zero-padded so containment checks below can't be fooled by numeric
        // substrings (e.g. "L0001" would otherwise match inside "L00010").
        const lines = Array.from(
          { length: 250 },
          (_, i) => `L${String(i + 1).padStart(4, '0')}`,
        );
        yield* writeLog(outputDirectory, lines.join('\n'));

        const logTail = failedLogTail(yield* compile());

        // Last 200 of 250 lines survive: L0051 .. L0250.
        expect(logTail).toContain('L0051');
        expect(logTail).toContain('L0250');
        expect(logTail).not.toContain('L0050');
        expect(logTail).not.toContain('L0001');
      }),
  );

  it.live('finds the engine log for a .ltx source, not just .tex', () =>
    Effect.gen(function* () {
      mocks.runToolWithCheck.mockReturnValue(Effect.succeed(execResult(false)));

      const outputDirectory = path.join(workspacePath, 'build.ltx');
      // The engine always names the log after the source with ITS OWN
      // extension stripped, regardless of which LaTeX extension was used.
      yield* writeLog(outputDirectory, 'engine log content');

      const logTail = failedLogTail(
        yield* compile('main.ltx', outputDirectory),
      );

      expect(logTail).toContain('engine log content');
      expect(logTail).not.toContain('no LaTeX log at');
    }),
  );

  it.live(
    'falls back to a discoverable placeholder when no engine log exists on disk',
    () =>
      Effect.gen(function* () {
        mocks.runToolWithCheck.mockReturnValue(
          Effect.succeed(execResult(false)),
        );

        const logTail = failedLogTail(
          yield* compile(
            'missing.tex',
            path.join(workspacePath, 'build-missing'),
          ),
        );

        expect(logTail).toContain('no LaTeX log at');
      }),
  );

  it.live(
    'surfaces the exception message as logTail when the compiler invocation throws',
    () =>
      Effect.gen(function* () {
        mocks.runToolWithCheck.mockReturnValue(
          Effect.fail(new Error('boom: pdflatex crashed')),
        );

        const logTail = failedLogTail(yield* compile());

        expect(logTail).toContain('boom: pdflatex crashed');
      }),
  );
});

// #10635: compileLatex2Pdf resolves its channel per call from the threaded
// option (defaulting to the module channel) — the entries the host sink
// receives must carry the resolved channel.
describe('compileLatex2Pdf logger seam', () => {
  beforeEach(async () => {
    mocks.runToolWithCheck.mockReset();
    await installPlatform({ workspacePath });
  });

  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  it.live(
    'warns on the module channel when latexmk is missing and pdflatex takes over',
    () =>
      Effect.gen(function* () {
        mocks.runToolWithCheck
          .mockReturnValueOnce(Effect.succeed(false))
          .mockReturnValueOnce(Effect.succeed(execResult(true)));
        const logs = captureLogEntries();

        const result = yield* compile().pipe(
          Effect.provide(effectDiagnosticsLayer),
        );

        expect(result.ok).toBe(true);
        expect(
          logs.has('WARN', LATEX_COMMANDS_CHANNEL, 'latexmk not found'),
        ).toBe(true);
      }),
  );
});
