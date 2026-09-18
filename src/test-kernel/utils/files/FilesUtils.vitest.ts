// Suites for src/utils/files (workspaceFS, mime, entry probes, pasted images,
// rooted filesystem confinement).

import * as assert from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Cause, Effect, Exit, FileSystem, Path } from 'effect';
import { isTexFile } from '@common/files/fileTypeUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { getMimeType } from '@utils/files/mimeUtils';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { pastedImageFileName } from '@utils/files/pastedImageUtils';
import { entryExists } from '@utils/files/fsEntryExists';
import { rootedFileSystem } from '@utils/files/rootedFileSystem';

// ---------------------------------------------------------------------------
// mimeUtils
// ---------------------------------------------------------------------------

describe('getMimeType', () => {
  it('applies audio override for known extensions from file paths', () => {
    assert.strictEqual(getMimeType('/tmp/clip.opus'), 'audio/opus');
    assert.strictEqual(getMimeType('C:\\tmp\\clip.l16'), 'audio/l16');
  });
});

// ---------------------------------------------------------------------------
// fileTypeUtils and workspace path resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PastedImageUtils
// ---------------------------------------------------------------------------

describe('pastedImageFileName', () => {
  it('accepts generated pasted image basenames', () => {
    expect(pastedImageFileName('pasted_1234_abcd.png')).toBe(
      'pasted_1234_abcd.png',
    );
  });

  it.each([
    '../pasted_1234_abcd.png',
    '/tmp/pasted_1234_abcd.png',
    'C:\\tmp\\pasted_1234_abcd.png',
    'avatar.png',
    '',
  ])('rejects paths and non-pasted names from webview input: %s', (name) => {
    expect(() => pastedImageFileName(name)).toThrow(
      'Invalid pasted image filename.',
    );
  });
});

// ---------------------------------------------------------------------------
// Rooted filesystem confinement
// ---------------------------------------------------------------------------

describe('rootedFileSystem confinement', () => {
  const escapes: ReadonlyArray<
    readonly [
      string,
      (
        view: ReturnType<typeof rootedFileSystem>,
      ) => Effect.Effect<unknown, unknown>,
    ]
  > = [
    ['an escaped `..` glob segment', (view) => view.glob('\\.\\./outside/**')],
    [
      'a bracket-class `..` glob segment',
      (view) => view.glob('[.][.]/outside/**'),
    ],
    [
      'a `../`-prefixed temp name',
      (view) => view.makeTempFile({ prefix: '../escape-' }),
    ],
  ];

  effectIt.live.each(escapes)('rejects %s with BadArgument', ([, operate]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The root sits alone in a scoped parent, so anything an escape
      // created beside it shows up there and is removed with the parent.
      const parent = yield* fs.makeTempDirectoryScoped({
        prefix: 'texra-rooted-fs-',
      });
      const root = path.join(parent, 'root');
      yield* fs.makeDirectory(root);
      const exit = yield* Effect.exit(
        operate(rootedFileSystem(root, fs, path)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
      ).toMatchObject({ reason: { _tag: 'BadArgument' } });
      expect(yield* fs.readDirectory(parent)).toEqual(['root']);
    }).pipe(Effect.scoped, Effect.provide(nodePlatformLayer)),
  );
});

// ---------------------------------------------------------------------------
// entryExists
// ---------------------------------------------------------------------------

describe('entryExists', () => {
  effectIt.live('reads a dangling symlink as an entry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: 'texra-entry-exists-',
      });
      const gone = path.join(root, 'gone.tex');
      const dangling = path.join(root, 'dangling.tex');
      const cyclic = path.join(root, 'cyclic.tex');
      const file = path.join(root, 'real.tex');
      yield* fs.symlink(gone, dangling);
      yield* fs.symlink(cyclic, cyclic);
      yield* fs.writeFileString(file, 'body');

      // The facade's lstat-backed probe named the link itself where the
      // `access(2)` behind `FileSystem.exists` cannot resolve its target, so
      // the readLink half is what keeps a caller from reading the dangling
      // path as new and then writing through the link.
      expect(yield* entryExists(fs, dangling)).toBe(true);
      expect(yield* entryExists(fs, cyclic)).toBe(true);
      expect(yield* entryExists(fs, file)).toBe(true);
      // Absent, and a parent that is not a directory, still read as absent.
      expect(yield* entryExists(fs, gone)).toBe(false);
      expect(yield* entryExists(fs, path.join(file, 'child'))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(nodePlatformLayer)),
  );
});
