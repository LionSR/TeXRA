import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { describe, expect } from 'vitest';

import { AppSignals, createWorkspaceLocation } from '@texra-ai/harness/plugins';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
import { writeFileIfUnchanged } from '@texra/common/files/projectFileWrite';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

describe('acceptEditedFileReplace', () => {
  it.effect(
    'does not delete the just-accepted file when it collides with the derived diff name',
    () =>
      Effect.gen(function* () {
        // base is literally named "<edited-stem>_diff.tex" — the same name
        // staleDiffFileLocation would derive for this edited/base pair — so the
        // write target and the "stale diff" coincide.
        const ws = yield* Effect.promise(() =>
          makeTempDir('texra-accept-', tempDirs),
        );
        const base = path.join(ws, 'paper_diff.tex');
        const edited = path.join(ws, 'paper.tex');
        yield* Effect.promise(async () => {
          await nodeFs.writeFile(base, 'old');
          await nodeFs.writeFile(edited, 'edited content');
        });

        const accepted = yield* acceptEditedFileReplace(
          createWorkspaceLocation(base, 'paper_diff.tex'),
          createWorkspaceLocation(edited, 'paper.tex'),
          {
            confirm: () => Effect.succeed(true),
            showInfo: () => Effect.void,
            write: writeFileIfUnchanged,
          },
        ).pipe(Effect.provide([nodePlatformLayer, AppSignals.layer]));

        expect(Option.isSome(accepted)).toBe(true);
        expect(yield* Effect.promise(() => nodeFs.readFile(base, 'utf8'))).toBe(
          'edited content',
        );
      }),
  );

  it.effect(
    'writes through a symlinked target, keeping the link and its mode',
    () =>
      Effect.gen(function* () {
        const ws = yield* Effect.promise(() =>
          makeTempDir('texra-accept-', tempDirs),
        );
        const shared = path.join(ws, 'shared.tex');
        const base = path.join(ws, 'paper.tex');
        const edited = path.join(ws, 'paper_edited.tex');
        yield* Effect.promise(async () => {
          await nodeFs.writeFile(shared, 'old');
          await nodeFs.chmod(shared, 0o640);
          await nodeFs.symlink(shared, base);
          await nodeFs.writeFile(edited, 'new');
        });

        const accepted = yield* acceptEditedFileReplace(
          createWorkspaceLocation(base, 'paper.tex'),
          createWorkspaceLocation(edited, 'paper_edited.tex'),
          {
            confirm: () => Effect.succeed(true),
            showInfo: () => Effect.void,
            write: writeFileIfUnchanged,
          },
        ).pipe(Effect.provide([nodePlatformLayer, AppSignals.layer]));

        expect(Option.getOrUndefined(accepted)).toBe('new');
        const link = yield* Effect.promise(() => nodeFs.lstat(base));
        expect(link.isSymbolicLink()).toBe(true);
        // Windows keeps no POSIX mode: `chmod` there only sets the read-only
        // bit and `stat` reports 0o666 for any writable file.
        if (process.platform !== 'win32') {
          const target = yield* Effect.promise(() => nodeFs.stat(shared));
          expect(target.mode & 0o777).toBe(0o640);
        }
        expect(
          yield* Effect.promise(() => nodeFs.readFile(shared, 'utf8')),
        ).toBe('new');
      }),
  );
});
