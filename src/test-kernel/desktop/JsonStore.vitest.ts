// Node imports
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { build } from 'esbuild';
import { Effect, Fiber } from 'effect';
import { describe, expect } from 'vitest';

// Local imports - test support
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { moduleFileUrl, repoPath } from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

const JSON_STORE_SOURCE = repoPath(
  'src',
  'platform',
  'defaults',
  'jsonStore.ts',
);

async function loadJsonStore(): Promise<
  typeof import('@platform/defaults/jsonStore').JsonStore
> {
  const { JsonStore } = await loadSourceModule('@platform/defaults/jsonStore');
  return JsonStore;
}

async function readStoredJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * Entry that re-exports the store beside the `Effect` module it was bundled
 * with, so a bundle's programs are run by the same copy of Effect that built
 * them — `open` and `set` are Effects, and a second copy would not run them.
 */
async function writeBundleEntry(dir: string): Promise<string> {
  const entry = join(dir, 'jsonStoreEntry.ts');
  await writeFile(
    entry,
    `export { JsonStore } from ${JSON.stringify(JSON_STORE_SOURCE)};\nexport { Effect } from 'effect';\n`,
  );
  return entry;
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

  it.effect('fails on malformed JSON without changing the original bytes', () =>
    Effect.gen(function* () {
      const JsonStore = yield* Effect.promise(() => loadJsonStore());
      const original = '{"truncated"';
      const filePath = yield* Effect.promise(() =>
        createTempFile('state.json', original),
      );

      const error = yield* Effect.flip(JsonStore.open(filePath));
      expect(error).toBeInstanceOf(SyntaxError);
      expect(yield* Effect.promise(() => readFile(filePath, 'utf8'))).toBe(
        original,
      );
    }),
  );

  it.effect.each([
    ['array', '[]'],
    ['null', 'null'],
    ['string', '"text"'],
  ])('treats valid non-object JSON (%s) as corruption', ([_kind, content]) =>
    Effect.gen(function* () {
      const JsonStore = yield* Effect.promise(() => loadJsonStore());
      const filePath = yield* Effect.promise(() =>
        createTempFile('state.json', content),
      );

      const error = yield* Effect.flip(JsonStore.open(filePath));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toContain('to contain a JSON object');
    }),
  );

  it.effect(
    'merges with a concurrent writer instead of flushing a stale open-time snapshot',
    () =>
      Effect.gen(function* () {
        const JsonStore = yield* Effect.promise(() => loadJsonStore());
        const filePath = yield* Effect.promise(() =>
          createTempFile('state.json', '{"keep": 1, "drop": 1}\n'),
        );

        const store = yield* JsonStore.open(filePath);
        // Simulate another process persisting a key while this store sits
        // open (e.g. across an awaited network fetch).
        yield* Effect.promise(() =>
          writeFile(filePath, '{"keep": 1, "drop": 1, "foreign": 2}\n'),
        );

        yield* store.set('drop', undefined);

        expect(yield* Effect.promise(() => readStoredJson(filePath))).toEqual({
          keep: 1,
          foreign: 2,
        });
      }),
  );

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
        expect(yield* Effect.promise(() => readFile(filePath, 'utf8'))).toBe(
          corrupt,
        );
      }),
  );

  it.effect(
    'preserves loaded keys when the backing file disappears before a mutation',
    () =>
      Effect.gen(function* () {
        const JsonStore = yield* Effect.promise(() => loadJsonStore());
        const filePath = yield* Effect.promise(() =>
          createTempFile('state.json', '{"keep": 1}\n'),
        );
        const store = yield* JsonStore.open(filePath);

        yield* Effect.promise(() => rm(filePath));
        yield* store.set('added', 2);

        expect(yield* Effect.promise(() => readStoredJson(filePath))).toEqual({
          keep: 1,
          added: 2,
        });
      }),
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
      }),
  );

  it.effect('flushes chained sets in call order, not in wake-up order', () =>
    Effect.gen(function* () {
      const JsonStore = yield* Effect.promise(() => loadJsonStore());
      const filePath = yield* Effect.promise(() =>
        createTempFile('state.json', '{}\n'),
      );
      const store = yield* JsonStore.open(filePath);

      // The third set is issued from the continuation of the first, while
      // the second is still queued behind it. A lane that wakes waiters in a
      // scheduled task lets the third flush barge ahead of the second and
      // leaves the file at 2 while memory says 3.
      const first = yield* Effect.forkChild(store.set('k', 1));
      const second = yield* Effect.forkChild(store.set('k', 2));
      yield* Fiber.join(first);
      const third = yield* Effect.forkChild(store.set('k', 3));
      yield* Fiber.join(second);
      yield* Fiber.join(third);

      expect(store.get('k')).toBe(3);
      expect(yield* Effect.promise(() => readStoredJson(filePath))).toEqual({
        k: 3,
      });
    }),
  );

  it('keeps the lock function callable in a split ESM bundle', async () => {
    tempDir = await makeTempDir('texra-json-store-bundle-', tempDirs);
    const outdir = join(tempDir, 'bundle');
    await build({
      entryPoints: {
        jsonStore: await writeBundleEntry(tempDir),
      },
      bundle: true,
      format: 'esm',
      splitting: true,
      platform: 'node',
      outdir,
      outExtension: { '.js': '.mjs' },
      logLevel: 'silent',
      tsconfig: repoPath('tsconfig.json'),
      nodePaths: [repoPath('node_modules')],
    });

    const { JsonStore, Effect: bundledEffect } = (await import(
      moduleFileUrl(join(outdir, 'jsonStore.mjs'))
    )) as typeof import('@platform/defaults/jsonStore') & {
      Effect: typeof Effect;
    };
    const filePath = join(tempDir, 'state.json');
    const store = await bundledEffect.runPromise(JsonStore.open(filePath));

    await bundledEffect.runPromise(store.set('persisted', true));

    expect(await readStoredJson(filePath)).toEqual({
      persisted: true,
    });
  });

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
        const filePath = join(dir, 'secrets.json');
        // Unwritable parent: any open-time mkdir/chmod would throw (#8220).
        yield* Effect.promise(() => chmod(tempDir!, 0o500));

        try {
          const store = yield* JsonStore.open(filePath, { mode: 0o600 });

          expect(store.get('key', 'fallback')).toBe('fallback');
          yield* Effect.promise(() =>
            expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' }),
          );

          yield* Effect.promise(() => chmod(tempDir!, 0o700));
          yield* store.set('key', 'value');

          const fileStat = yield* Effect.promise(() => stat(filePath));
          const dirStat = yield* Effect.promise(() => stat(dir));
          expect(fileStat.mode & 0o777).toBe(0o600);
          expect(dirStat.mode & 0o777).toBe(0o700);
        } finally {
          yield* Effect.promise(() => chmod(tempDir!, 0o700));
        }
      }),
  );
});
