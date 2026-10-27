import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import { createDesktopWorkspaceIpc } from '@desktop/main/desktopWorkspaceIpc';
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

let fixtureRoot = '';
let workspacePath = '';
let externalPath = '';
let missingExternalPath = '';

function createIpc() {
  const ipc = createDesktopWorkspaceIpc(
    { postToRenderer: () => {} },
    {
      ptyHost: {
        create: async () => {
          throw new Error('Terminal is not used in this test.');
        },
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
      getWorkspacePath: () => workspacePath,
    },
  );
  // The IPC follows a process-global bus, so a fixture whose scope stayed
  // open would keep reacting to later tests' emits.
  const scope = Scope.makeUnsafe();
  liveScopes.push(scope);
  testRuntime().runSync(
    Effect.forkIn(ipc.followFilesWritten, scope, { startImmediately: true }),
  );
  return ipc;
}

const liveScopes: Scope.Closeable[] = [];

describe('desktop workspace IPC', () => {
  const tempDirs = useTempDirs();

  beforeEach(async () => {
    fixtureRoot = await makeTempDir('texra-workspace-ipc-', tempDirs);
    workspacePath = join(fixtureRoot, 'workspace');
    externalPath = join(fixtureRoot, 'external.txt');
    missingExternalPath = join(fixtureRoot, 'missing-external.txt');
    mkdirSync(workspacePath);
    writeFileSync(join(workspacePath, 'paper.tex'), 'inside', 'utf8');
    writeFileSync(externalPath, 'outside', 'utf8');
    symlinkSync(externalPath, join(workspacePath, 'linked.tex'));
    symlinkSync(
      missingExternalPath,
      join(workspacePath, 'dangling-linked.tex'),
    );
    const { installPlatform } = await import('@test/support/setupPlatform');
    await installPlatform({ workspacePath });
  });

  afterEach(() => {
    for (const scope of liveScopes.splice(0))
      testRuntime().runFork(Scope.close(scope, Exit.void));
  });

  it.effect(
    'reads regular workspace files but rejects symlink targets outside the workspace',
    () =>
      Effect.gen(function* () {
        const ipc = createIpc();
        const context = yield* testRuntime().contextEffect;

        expect(
          yield* ipc
            .file({ kind: 'read', path: 'paper.tex' })
            .pipe(Effect.provide(context)),
        ).toEqual({ kind: 'contents', contents: 'inside' });

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
          const exit = yield* Effect.exit(
            program.pipe(Effect.provide(context)),
          );
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
        const ipc = createIpc();
        const context = yield* testRuntime().contextEffect;
        const save = (contents: string, base: string | null) =>
          ipc
            .file({ kind: 'write', path: 'paper.tex', contents, base })
            .pipe(Effect.provide(context));
        // A run rewrote the file while the editor held "inside".
        writeFileSync(join(workspacePath, 'paper.tex'), 'from the run');

        expect(yield* save('inside, edited', 'inside')).toEqual({
          kind: 'changedOnDisk',
        });
        expect(readFileSync(join(workspacePath, 'paper.tex'), 'utf8')).toBe(
          'from the run',
        );
        // Saved against what is on disk now, or overwritten on purpose.
        expect(yield* save('run, edited', 'from the run')).toEqual({
          kind: 'done',
        });
        expect(yield* save('mine', null)).toEqual({ kind: 'done' });
        expect(readFileSync(join(workspacePath, 'paper.tex'), 'utf8')).toBe(
          'mine',
        );
      }),
  );
});
