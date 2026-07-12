// Node imports
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
