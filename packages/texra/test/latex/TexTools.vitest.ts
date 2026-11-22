import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { pathToLocationIn } from '@texra-ai/worldline/plugins';
import { compileLatex2Pdf } from '@latex/texTools';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { rootedFsLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';
import { TEXRA_APP } from '@test/support/texraApp';

/** The workspace and build folder of the test's host. */
const hostDirs = Effect.map(FakeHost, (host) => ({
  workspaceRoot: host.path('workspace'),
  buildDir: host.path('workspace', 'build'),
}));

/** A spawner whose engine exits 0, writing `pdf` (its bytes) into the
 *  build folder first when given, as a real engine run does. */
const engineExits = (buildDir: string, pdf?: string) =>
  scriptedSpawnerLayer(() => {
    if (pdf !== undefined) {
      mkdirSync(buildDir, { recursive: true });
      writeFileSync(path.join(buildDir, 'main.pdf'), pdf);
    }
    return { exitCode: 0 };
  });

/** Compile the workspace's `main.tex` into `build/`, over the test
 *  host's roots, as a session hands them, with `engine` as the spawner. */
const compileMain = (engine: ReturnType<typeof engineExits>) =>
  Effect.gen(function* () {
    const { roots } = yield* FakeHost;
    const { workspaceRoot, buildDir } = yield* hostDirs;
    return yield* compileLatex2Pdf(
      pathToLocationIn(roots.workspace, path.join(workspaceRoot, 'main.tex')),
      roots,
      { outputDirectory: buildDir },
    ).pipe(Effect.provide([rootedFsLayer(roots), engine.layer]));
  });

// Exercises the real production code; only the process spawner is scripted.
layer(FakeHost.layer({ app: TEXRA_APP }), {
  buildPerTest: true,
  excludeTestServices: true,
})('compileLatex2Pdf structured return', (it) => {
  it.effect(
    'returns { ok: true } with the engine PDF path and no logTail on success',
    () =>
      Effect.gen(function* () {
        const { workspaceRoot, buildDir } = yield* hostDirs;
        const engine = engineExits(buildDir, '%PDF-1.5');

        const result = yield* compileMain(engine);

        expect(result).toEqual({
          ok: true,
          pdfPath: path.join(buildDir, 'main.pdf'),
        });
        // The engine runs in the session's workspace root, with the
        // kpathsea overrides ranking the document's own directory ahead of
        // the compiler's cwd (".") and the workspace root behind both.
        const D = path.delimiter;
        expect(engine.calls).toHaveLength(1);
        expect(engine.calls[0]).toMatchObject({
          command: 'latexmk',
          options: {
            cwd: workspaceRoot,
            // latexmk's engine passes are its children: a stop signals them,
            // through its own process group (Windows kills the tree instead).
            detached: process.platform !== 'win32',
            env: expect.objectContaining({
              TEXINPUTS: expect.stringContaining(
                `${workspaceRoot}${D}.${D}${workspaceRoot}${D}`,
              ),
            }),
          },
        });
      }),
  );

  // An engine exits 0 on a document with no pages and writes no PDF; a
  // success there sent callers to open a file that is not there.
  it.effect('reports an exit 0 that wrote no PDF as a failure', () =>
    Effect.gen(function* () {
      const { buildDir } = yield* hostDirs;
      const result = yield* compileMain(engineExits(buildDir));

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.logTail).toContain(
        `wrote no PDF at ${path.join(buildDir, 'main.pdf')}`,
      );
    }),
  );
});
