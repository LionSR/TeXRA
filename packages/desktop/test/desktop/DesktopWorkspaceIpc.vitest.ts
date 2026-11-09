import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { beforeEach, expect } from 'vitest';

import { createDesktopWorkspaceIpc } from '@desktop/main/desktopWorkspaceIpc';
import { createFakeHost } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

let fixtureRoot = '';
let workspaceRoot = '';
let externalPath = '';
let missingExternalPath = '';

/** The IPC with its file follower running for the test's scope: it follows
 *  a process-global bus, so a follower that outlived the test would keep
 *  reacting to later tests' emits. */
const createIpc = Effect.gen(function* () {
  const ipc = createDesktopWorkspaceIpc(
    { postToRenderer: () => {} },
    {
      ptyHost: {
        create: () =>
          Effect.die(new Error('Terminal is not used in this test.')),
        get: () => undefined,
        disposeAll: () => {},
      },
      browserViews: {
        open: () => {},
        show: () => {},
        hideAll: () => {},
        close: () => {},
        disposeAll: () => {},
      },
      toWindowBounds: (bounds) => bounds,
      getWorkspacePath: () => workspaceRoot,
    },
  );
  yield* Effect.forkScoped(ipc.followFilesWritten, { startImmediately: true });
  return ipc;
});

layer(SessionGraph.hosted)('desktop workspace IPC', (it) => {
  const tempDirs = useTempDirs();

  beforeEach(async () => {
    fixtureRoot = await makeTempDir('texra-workspace-ipc-', tempDirs);
    workspaceRoot = join(fixtureRoot, 'workspace');
    externalPath = join(fixtureRoot, 'external.txt');
    missingExternalPath = join(fixtureRoot, 'missing-external.txt');
    mkdirSync(workspaceRoot);
    writeFileSync(join(workspaceRoot, 'paper.tex'), 'inside', 'utf8');
    writeFileSync(externalPath, 'outside', 'utf8');
    symlinkSync(externalPath, join(workspaceRoot, 'linked.tex'));
    symlinkSync(
      missingExternalPath,
      join(workspaceRoot, 'dangling-linked.tex'),
    );
  });

  it.layer(
    FakeHost.layer(() => createFakeHost({ workspaceRoot })),
    {
      buildPerTest: true,
    },
  )((it) => {
    it.effect(
      'reads regular workspace files but rejects symlink targets outside the workspace',
      () =>
        Effect.gen(function* () {
          const ipc = yield* createIpc;

          expect(yield* ipc.file({ kind: 'read', path: 'paper.tex' })).toEqual({
            kind: 'contents',
            contents: 'inside',
          });

          const refused = [
            ipc.file({ kind: 'read', path: 'linked.tex' }),
            ipc.file({
              kind: 'write',
              path: 'linked.tex',
              base: null,
              contents: 'overwritten',
            }),
            ipc.file({
              kind: 'write',
              path: 'dangling-linked.tex',
              base: null,
              contents: 'created outside',
            }),
          ];
          for (const program of refused) {
            const exit = yield* Effect.exit(program);
            expect(Exit.isFailure(exit)).toBe(true);
          }
          expect(readFileSync(externalPath, 'utf8')).toBe('outside');
          expect(existsSync(missingExternalPath)).toBe(false);
        }),
    );

    it.effect(
      'refuses a save over a file that changed on disk since the editor read it',
      () =>
        Effect.gen(function* () {
          const ipc = yield* createIpc;
          const save = (contents: string, base: string | null) =>
            ipc.file({ kind: 'write', path: 'paper.tex', contents, base });
          // A run rewrote the file while the editor held "inside".
          writeFileSync(join(workspaceRoot, 'paper.tex'), 'from the run');

          expect(yield* save('inside, edited', 'inside')).toEqual({
            kind: 'changedOnDisk',
          });
          expect(readFileSync(join(workspaceRoot, 'paper.tex'), 'utf8')).toBe(
            'from the run',
          );
          // Saved against what is on disk now, or overwritten on purpose.
          expect(yield* save('run, edited', 'from the run')).toEqual({
            kind: 'done',
          });
          expect(yield* save('mine', null)).toEqual({ kind: 'done' });
          expect(readFileSync(join(workspaceRoot, 'paper.tex'), 'utf8')).toBe(
            'mine',
          );
        }),
    );
  });
});
