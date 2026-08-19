// Node imports
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Third-party imports
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { moduleFileUrl, repoPath } from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

const require = createRequire(import.meta.url);

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

  it('fails on malformed JSON without changing the original bytes', async () => {
    const JsonStore = await loadJsonStore();
    const original = '{"truncated"';
    const filePath = await createTempFile('state.json', original);

    await expect(JsonStore.open(filePath)).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it.each([
    ['array', '[]'],
    ['null', 'null'],
    ['string', '"text"'],
  ])('treats valid non-object JSON (%s) as corruption', async (_, content) => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile('state.json', content);

    await expect(JsonStore.open(filePath)).rejects.toThrow(
      'to contain a JSON object',
    );
  });

  it('merges with a concurrent writer instead of flushing a stale open-time snapshot', async () => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile(
      'state.json',
      '{"keep": 1, "drop": 1}\n',
    );

    const store = await JsonStore.open(filePath);
    // Simulate another process persisting a key while this store sits open
    // (e.g. across an awaited network fetch).
    await writeFile(filePath, '{"keep": 1, "drop": 1, "foreign": 2}\n');

    await store.set('drop', undefined);

    expect(await readStoredJson(filePath)).toEqual({
      keep: 1,
      foreign: 2,
    });
  });

  it('rejects a mutation when the file becomes corrupt and preserves its bytes', async () => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile('state.json', '{"keep": 1}\n');
    const store = await JsonStore.open(filePath);

    const corrupt = '{"truncated"';
    await writeFile(filePath, corrupt);

    await expect(store.set('added', 2)).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(filePath, 'utf8')).toBe(corrupt);
  });

  it('preserves loaded keys when the backing file disappears before a mutation', async () => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile('state.json', '{"keep": 1}\n');
    const store = await JsonStore.open(filePath);

    await rm(filePath);
    await store.set('added', 2);

    expect(await readStoredJson(filePath)).toEqual({
      keep: 1,
      added: 2,
    });
  });

  it('serializes overlapping writes from separate instances on the same file', async () => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile('state.json', '{}\n');

    const [a, b] = await Promise.all([
      JsonStore.open(filePath),
      JsonStore.open(filePath),
    ]);
    // Both instances opened off the same on-disk snapshot; without per-path
    // read-modify-write serialization the later flush drops the other's key.
    await Promise.all([a.set('fromA', 'a'), b.set('fromB', 'b')]);

    expect(await readStoredJson(filePath)).toEqual({
      fromA: 'a',
      fromB: 'b',
    });
  });

  it('keeps the lock function callable in a split ESM bundle', async () => {
    tempDir = await makeTempDir('texra-json-store-bundle-', tempDirs);
    const outdir = join(tempDir, 'bundle');
    await build({
      entryPoints: {
        jsonStore: JSON_STORE_SOURCE,
      },
      bundle: true,
      format: 'esm',
      splitting: true,
      platform: 'node',
      outdir,
      outExtension: { '.js': '.mjs' },
      logLevel: 'silent',
    });

    const { JsonStore } = (await import(
      moduleFileUrl(join(outdir, 'jsonStore.mjs'))
    )) as typeof import('@platform/defaults/jsonStore');
    const filePath = join(tempDir, 'state.json');
    const store = await JsonStore.open(filePath);

    await store.set('persisted', true);

    expect(await readStoredJson(filePath)).toEqual({
      persisted: true,
    });
  });

  it('waits for a cross-process lock before merging its mutation', async () => {
    const filePath = await createTempFile('state.json', '{"initial": 1}\n');
    const bundlePath = join(tempDir!, 'jsonStore.cjs');
    const lockAttemptPath = join(tempDir!, 'lock-attempted');
    const lockShimPath = join(tempDir!, 'proper-lockfile.cjs');
    await writeFile(
      lockShimPath,
      `
        const fs = require('node:fs');
        const actual = require(${JSON.stringify(require.resolve('proper-lockfile'))});
        const lockFs = Object.create(fs);
        lockFs.mkdir = (path, callback) => fs.mkdir(path, (error) => {
          fs.writeFileSync(${JSON.stringify(lockAttemptPath)}, '');
          callback(error);
        });
        exports.lock = (file, options) => actual.lock(file, {
          ...options,
          fs: lockFs,
        });
      `,
    );
    await build({
      entryPoints: [JSON_STORE_SOURCE],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      outfile: bundlePath,
      logLevel: 'silent',
      plugins: [
        {
          name: 'signal-lock-attempt',
          setup(context) {
            context.onResolve({ filter: /^proper-lockfile$/ }, () => ({
              path: lockShimPath,
            }));
          },
        },
      ],
    });
    await mkdir(`${filePath}.lock`);

    const script = `
      (async () => {
        const { JsonStore } = require(${JSON.stringify(bundlePath)});
        const store = await JsonStore.open(${JSON.stringify(filePath)});
        console.log('ready');
        await store.set('child', 2);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    const child = spawn(process.execPath, ['--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error(Buffer.concat(stderr).toString());
      }),
    ]);
    await expect
      .poll(() =>
        stat(lockAttemptPath).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const whileLocked = await readStoredJson(filePath);

    await writeFile(filePath, '{"initial": 1, "foreign": 2}\n');
    await rm(`${filePath}.lock`, { recursive: true });
    const [exitCode] = await exited;
    if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString());

    expect(whileLocked).toEqual({ initial: 1 });
    expect(await readStoredJson(filePath)).toEqual({
      initial: 1,
      foreign: 2,
      child: 2,
    });
  });

  it('opens read-only on unwritable storage; only the first write prepares the directory', async () => {
    if (process.platform === 'win32') return; // POSIX modes don't apply.
    const JsonStore = await loadJsonStore();
    tempDir = await makeTempDir('texra-json-store-', tempDirs);
    const dir = join(tempDir, 'nested');
    const filePath = join(dir, 'secrets.json');
    // Unwritable parent: any open-time mkdir/chmod would throw (#8220).
    await chmod(tempDir, 0o500);

    try {
      const store = await JsonStore.open(filePath, {
        mode: 0o600,
      });

      expect(store.get('key', 'fallback')).toBe('fallback');
      await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });

      await chmod(tempDir, 0o700);
      await store.set('key', 'value');

      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await chmod(tempDir, 0o700);
    }
  });

  it('restricts the store file and its directory to the owner when a mode is set', async () => {
    if (process.platform === 'win32') return; // POSIX modes don't apply.
    const JsonStore = await loadJsonStore();
    tempDir = await makeTempDir('texra-json-store-', tempDirs);
    const filePath = join(tempDir, 'nested', 'secrets.json');

    const store = await JsonStore.open(filePath, {
      mode: 0o600,
    });
    await store.set('key', 'value');

    const fileStat = await stat(filePath);
    const dirStat = await stat(dirname(filePath));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});
