import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, expect, vi } from 'vitest';

import { pathToLocationIn } from '@texra-ai/harness/host';
import { compileLatex2Pdf } from '@latex/texTools';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { fakePath } from '@test/support/FakePlatform';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';
import { TEXRA_APP } from '@test/support/texraApp';

const mocks = vi.hoisted(() => ({
  runTool: vi.fn(),
}));

vi.mock('@texra/utils/system/toolChecks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@texra/utils/system/toolChecks')>();
  return { ...actual, runTool: mocks.runTool };
});

const workspacePath = fakePath('workspace');
const buildDir = path.join(workspacePath, 'build');

/** The engine's exit: 0, writing `pdf` (its bytes) into the build folder
 *  first when given, as a real engine run does. */
const engineExits = (pdf?: string) =>
  Effect.sync(() => {
    if (pdf !== undefined) {
      mkdirSync(buildDir, { recursive: true });
      writeFileSync(path.join(buildDir, 'main.pdf'), pdf);
    }
    return {
      success: true,
      stdout: '',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    };
  });

/** Compile the workspace's `main.tex` into `build/`, over the installed
 *  host's roots, as a session hands them. */
const compileMain = () => {
  const roots = testWorkspaceRoots();
  return compileLatex2Pdf(
    pathToLocationIn(roots.workspace, path.join(workspacePath, 'main.tex')),
    roots,
    { outputDirectory: buildDir },
  ).pipe(Effect.provide(rootedFsLayer(roots)));
};

// Exercises the real production code; only the subprocess call is mocked.
layer(FakeHost.layer({ app: TEXRA_APP, workspacePath }), {
  buildPerTest: true,
  excludeTestServices: true,
})('compileLatex2Pdf structured return', (it) => {
  beforeEach(() => {
    mocks.runTool.mockReset();
  });

  it.effect(
    'returns { ok: true } with the engine PDF path and no logTail on success',
    () =>
      Effect.gen(function* () {
        mocks.runTool.mockReturnValue(engineExits('%PDF-1.5'));

        const result = yield* compileMain();

        expect(result).toEqual({
          ok: true,
          pdfPath: path.join(buildDir, 'main.pdf'),
        });
        // The engine runs in the session's workspace root, with the
        // kpathsea overrides ranking the document's own directory ahead of
        // the compiler's cwd (".") and the workspace root behind both.
        const D = path.delimiter;
        expect(mocks.runTool).toHaveBeenCalledWith(
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

  // An engine exits 0 on a document with no pages and writes no PDF; a
  // success there sent callers to open a file that is not there.
  it.effect('reports an exit 0 that wrote no PDF as a failure', () =>
    Effect.gen(function* () {
      mocks.runTool.mockReturnValue(engineExits());

      const result = yield* compileMain();

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.logTail).toContain(
        `wrote no PDF at ${path.join(buildDir, 'main.pdf')}`,
      );
    }),
  );
});
