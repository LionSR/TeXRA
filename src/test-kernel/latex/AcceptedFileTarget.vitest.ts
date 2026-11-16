import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, FileSystem, Option } from 'effect';
import { describe, expect } from 'vitest';

import { createWorkspaceLocation } from '@texra-ai/harness/host';
import { AppSignals } from '@texra-ai/harness/plugins';
import { acceptEditedFileReplace } from '@latex/acceptedFileTarget';
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
        const base = createWorkspaceLocation(
          path.join(path.sep, 'ws', 'paper_diff.tex'),
          'paper_diff.tex',
        );
        const edited = createWorkspaceLocation(
          path.join(path.sep, 'ws', 'paper.tex'),
          'paper.tex',
        );
        // Every path reads back the edited content and nothing exists until
        // written; removals are recorded for the stale-diff cleanup.
        const removed: string[] = [];
        // cast: the accept path calls only these operations of the file system.
        const fs = {
          readFileString: () => Effect.succeed('edited content'),
          writeFileString: () => Effect.void,
          realPath: (absolutePath: string) => Effect.succeed(absolutePath),
          exists: () => Effect.succeed(false),
          remove: (absolutePath: string) =>
            Effect.sync(() => {
              removed.push(absolutePath);
            }),
        } as unknown as FileSystem.FileSystem;

        const accepted = yield* acceptEditedFileReplace(base, edited, {
          confirm: () => Effect.succeed(true),
          showInfo: () => Effect.void,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provide(AppSignals.layer),
        );

        expect(Option.isSome(accepted)).toBe(true);
        expect(removed).toEqual([]);
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
          },
        ).pipe(Effect.provide([nodePlatformLayer, AppSignals.layer]));

        expect(Option.getOrUndefined(accepted)).toBe('new');
        const link = yield* Effect.promise(() => nodeFs.lstat(base));
        expect(link.isSymbolicLink()).toBe(true);
        const target = yield* Effect.promise(() => nodeFs.stat(shared));
        expect(target.mode & 0o777).toBe(0o640);
        expect(
          yield* Effect.promise(() => nodeFs.readFile(shared, 'utf8')),
        ).toBe('new');
      }),
  );
});
