// Node imports
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports - test support
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { loadSourceModule } from './loadSourceModule.ts';

async function loadJsonStore(): Promise<
  typeof import('@platform/defaults/jsonStore').JsonStore
> {
  const { JsonStore } = await loadSourceModule('@platform/defaults/jsonStore');
  return JsonStore;
}

async function readStoredJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

describe('shared JsonStore', () => {
  const tempDirs = useTempDirs();
  let tempDir: string | undefined;

  async function createTempFile(
    name: string,
    contents: string,
  ): Promise<string> {
    tempDir = await makeTempDir('texra-json-store-', tempDirs);
    const filePath = join(tempDir, name);
    await writeFile(filePath, contents);
    return filePath;
  }

  it.effect(
    'rejects a mutation when the file becomes corrupt and preserves its bytes',
    () =>
      Effect.gen(function* () {
        const JsonStore = yield* Effect.promise(() => loadJsonStore());
        const filePath = yield* Effect.promise(() =>
          createTempFile('state.json', '{"keep": 1}\n'),
        );
        const store = yield* JsonStore.open(filePath);

        const corrupt = '{"truncated"';
        yield* Effect.promise(() => writeFile(filePath, corrupt));

        const error = yield* Effect.flip(store.set('added', 2));
        expect(error).toBeInstanceOf(SyntaxError);
        // #13188: a failed flush must not leave the value readable in memory.
        expect(store.get('added')).toBeUndefined();
        expect(yield* Effect.promise(() => readFile(filePath, 'utf8'))).toBe(
          corrupt,
        );
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect(
    'serializes overlapping writes from separate instances on the same file',
    () =>
      Effect.gen(function* () {
        const JsonStore = yield* Effect.promise(() => loadJsonStore());
        const filePath = yield* Effect.promise(() =>
          createTempFile('state.json', '{}\n'),
        );

        const [a, b] = yield* Effect.all(
          [JsonStore.open(filePath), JsonStore.open(filePath)],
          { concurrency: 'unbounded' },
        );
        // Both instances opened off the same on-disk snapshot; without
        // per-path read-modify-write serialization the later flush drops the
        // other's key.
        yield* Effect.all([a.set('fromA', 'a'), b.set('fromB', 'b')], {
          concurrency: 'unbounded',
        });

        expect(yield* Effect.promise(() => readStoredJson(filePath))).toEqual({
          fromA: 'a',
          fromB: 'b',
        });
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect(
    'opens read-only on unwritable storage; only the first write prepares the directory',
    () =>
      Effect.gen(function* () {
        if (process.platform === 'win32') return; // POSIX modes don't apply.
        const JsonStore = yield* Effect.promise(() => loadJsonStore());
        tempDir = yield* Effect.promise(() =>
          makeTempDir('texra-json-store-', tempDirs),
        );
        const dir = join(tempDir, 'nested');
        const filePath = join(dir, 'config.json');
        // Unwritable parent: any open-time mkdir would throw (#8220).
        yield* Effect.promise(() => chmod(tempDir!, 0o500));

        try {
          const store = yield* JsonStore.open(filePath);

          expect(store.get('key')).toBeUndefined();
          yield* Effect.promise(() =>
            expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' }),
          );

          yield* Effect.promise(() => chmod(tempDir!, 0o700));
          yield* store.set('key', 'value');

          expect(yield* Effect.promise(() => readStoredJson(filePath))).toEqual(
            { key: 'value' },
          );
        } finally {
          yield* Effect.promise(() => chmod(tempDir!, 0o700));
        }
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
