// Node imports
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Third-party imports
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { repoPath } from './desktopTestPaths.mjs';
import { loadPlatformDefaultsModule } from './loadPlatformDefaultsModule.mjs';

const require = createRequire(import.meta.url);

interface JsonStore {
  get<T>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): Promise<void>;
  snapshot(): Record<string, unknown>;
}

interface JsonStoreOptions {
  mode?: number;
  strict?: boolean;
}

interface JsonStoreModule {
  JsonStore: {
    open(filePath: string, options?: JsonStoreOptions): Promise<JsonStore>;
  };
}

async function loadJsonStore(): Promise<JsonStoreModule['JsonStore']> {
  const { JsonStore } =
    await loadPlatformDefaultsModule<JsonStoreModule>('jsonStore.ts');
  return JsonStore;
}

describe('shared JsonStore', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function createTempFile(
    name: string,
    contents: string,
  ): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-json-store-'));
    const filePath = join(tempDir, name);
    await writeFile(filePath, contents);
    return filePath;
  }

  it('recovers from malformed JSON stores and overwrites on the next write', async () => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile('state.json', '{"truncated"');

    const store = await JsonStore.open(filePath);

    expect(store.snapshot()).toEqual({});

    await store.set('ready', true);

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      ready: true,
    });
  });

  it('rethrows malformed JSON instead of discarding it when opened with strict: true', async () => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile('state.json', '{"truncated"');

    await expect(
      JsonStore.open(filePath, { strict: true }),
    ).rejects.toBeInstanceOf(SyntaxError);
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

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      keep: 1,
      foreign: 2,
    });
  });

  it('preserves its snapshot when a non-strict flush cannot reread the file', async () => {
    const JsonStore = await loadJsonStore();
    const filePath = await createTempFile('state.json', '{"keep": 1}\n');
    const store = await JsonStore.open(filePath);

    await writeFile(filePath, '{"truncated"');
    await store.set('added', 2);

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
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

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      fromA: 'a',
      fromB: 'b',
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
      entryPoints: [repoPath('src', 'platform', 'defaults', 'jsonStore.ts')],
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
    const whileLocked = JSON.parse(await readFile(filePath, 'utf8'));

    await writeFile(filePath, '{"initial": 1, "foreign": 2}\n');
    await rm(`${filePath}.lock`, { recursive: true });
    const [exitCode] = await exited;
    if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString());

    expect(whileLocked).toEqual({ initial: 1 });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      initial: 1,
      foreign: 2,
      child: 2,
    });
  });

  it('opens read-only on unwritable storage; only the first write prepares the directory', async () => {
    if (process.platform === 'win32') return; // POSIX modes don't apply.
    const JsonStore = await loadJsonStore();
    tempDir = await mkdtemp(join(tmpdir(), 'texra-json-store-'));
    const dir = join(tempDir, 'nested');
    const filePath = join(dir, 'secrets.json');
    // Unwritable parent: any open-time mkdir/chmod would throw (#8220).
    await chmod(tempDir, 0o500);

    try {
      const store = await JsonStore.open(filePath, { mode: 0o600 });

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
    tempDir = await mkdtemp(join(tmpdir(), 'texra-json-store-'));
    const filePath = join(tempDir, 'nested', 'secrets.json');

    const store = await JsonStore.open(filePath, { mode: 0o600 });
    await store.set('key', 'value');

    const fileStat = await stat(filePath);
    const dirStat = await stat(dirname(filePath));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});
