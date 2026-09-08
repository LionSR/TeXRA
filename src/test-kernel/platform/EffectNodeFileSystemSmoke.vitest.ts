import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as fs from 'node:fs';

import { Effect } from 'effect';
import * as FileSystem from 'effect/FileSystem';
import { describe, expect, it } from 'vitest';

import { effectNodeFileSystemLayer } from '@platform/defaults/effectNodeFileSystem';

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.provide(effect, effectNodeFileSystemLayer));

describe('effectNodeFileSystem', () => {
  it('round-trips a file, lists it, and stats it', async () => {
    const dir = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'efs-'));
    const file = nodePath.join(dir, 'a.txt');

    const result = await run(
      Effect.gen(function* () {
        const fsys = yield* FileSystem.FileSystem;
        yield* fsys.writeFileString(file, 'hello');
        const text = yield* fsys.readFileString(file);
        const entries = yield* fsys.readDirectory(dir);
        const info = yield* fsys.stat(file);
        const exists = yield* fsys.exists(file);
        const missing = yield* fsys.exists(nodePath.join(dir, 'nope.txt'));
        return {
          text,
          entries,
          type: info.type,
          size: Number(info.size),
          exists,
          missing,
        };
      }),
    );

    expect(result).toEqual({
      text: 'hello',
      entries: ['a.txt'],
      type: 'File',
      size: 5,
      exists: true,
      missing: false,
    });
  });

  it('reports NotFound for a missing file rather than fabricating success', async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const fsys = yield* FileSystem.FileSystem;
        return yield* fsys.readFile('/definitely/not/here.txt');
      }).pipe(Effect.result),
    );
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure') {
      expect(outcome.failure.reason._tag).toBe('NotFound');
    }
  });

  it('cannot classify a symlink through stat (follows the link)', async () => {
    const dir = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'efs-'));
    const target = nodePath.join(dir, 'target.txt');
    const link = nodePath.join(dir, 'link.txt');
    await fs.promises.writeFile(target, 'x');
    await fs.promises.symlink(target, link);

    const info = await run(
      Effect.flatMap(FileSystem.FileSystem, (fsys) => fsys.stat(link)),
    );
    // The repo's FileSystemProvider.isSymlink answers true here; Effect's
    // FileSystem has no lstat, so the symlink is invisible.
    expect(info.type).toBe('File');
  });

  it('readDirectory returns names only, with no entry type', async () => {
    const dir = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'efs-'));
    await fs.promises.mkdir(nodePath.join(dir, 'sub'));
    await fs.promises.writeFile(nodePath.join(dir, 'f.txt'), 'x');

    const entries = await run(
      Effect.flatMap(FileSystem.FileSystem, (fsys) => fsys.readDirectory(dir)),
    );
    expect(entries.sort()).toEqual(['f.txt', 'sub']);
    expect(entries.every((e) => typeof e === 'string')).toBe(true);
  });

  it('opens, writes and reads through a File handle', async () => {
    const dir = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'efs-'));
    const file = nodePath.join(dir, 'handle.bin');

    const text = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fsys = yield* FileSystem.FileSystem;
          const handle = yield* fsys.open(file, { flag: 'w+' });
          yield* handle.writeAll(new TextEncoder().encode('abcdef'));
          yield* handle.seek(FileSystem.Size(0), 'start');
          const chunk = yield* handle.readAlloc(FileSystem.Size(6));
          return chunk._tag === 'Some'
            ? new TextDecoder().decode(chunk.value)
            : '';
        }),
      ),
    );
    expect(text).toBe('abcdef');
  });
});
