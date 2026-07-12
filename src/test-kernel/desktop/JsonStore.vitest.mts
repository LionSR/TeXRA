// Node imports
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { loadPlatformDefaultsModule } from './loadPlatformDefaultsModule.mjs';

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
