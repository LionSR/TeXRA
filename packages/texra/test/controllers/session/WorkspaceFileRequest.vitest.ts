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

import { sessionFsLayer } from '@texra-ai/harness/host';
import { answerWorkspaceFile } from '@texra/controllers/session/workspaceFileRequest';
import { createFakeHost } from '@test/support/fakeHost';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

let fixtureRoot = '';
let workspaceRoot = '';
let externalPath = '';
let missingExternalPath = '';

/** The request over the test's workspace, as the window's dispatch provides
 *  its session's rooted filesystems. */
const file = (action: Parameters<typeof answerWorkspaceFile>[0]) =>
  answerWorkspaceFile(action).pipe(
    Effect.provide(
      sessionFsLayer({ workspace: workspaceRoot, storage: fixtureRoot }),
    ),
  );

layer(SessionGraph.hosted)('workspaceFile request', (it) => {
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
          expect(yield* file({ kind: 'read', path: 'paper.tex' })).toEqual({
            kind: 'contents',
            contents: 'inside',
          });

          const refused = [
            file({ kind: 'read', path: 'linked.tex' }),
            file({
              kind: 'write',
              path: 'linked.tex',
              base: null,
              contents: 'overwritten',
            }),
            file({
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
          const save = (contents: string, base: string | null) =>
            file({ kind: 'write', path: 'paper.tex', contents, base });
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
