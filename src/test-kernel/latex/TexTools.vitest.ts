import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { compileLatex2Pdf, type CompileLatex2PdfResult } from '@latex/texTools';
import type { ExecResult } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { fakePath } from '@test/support/FakePlatform';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { pathToLocationIn } from '@utils/files/fileLocation';

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

vi.mock('@texra/utils/system/toolChecks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@texra/utils/system/toolChecks')>();
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

// Exercises the real production code; only the subprocess call is mocked.
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
            // latexmk's engine passes are its children: a stop signals them.
            killProcessTree: true,
            env: expect.objectContaining({
              TEXINPUTS: expect.stringContaining(
                `${workspacePath}${D}.${D}${workspacePath}${D}`,
              ),
            }),
          }),
        );
      }),
  );
});
