// Node imports
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { loadPlatformDefaultsModule } from './loadPlatformDefaultsModule.mjs';

interface JsonStore {
  set(key: string, value: unknown): Promise<void>;
  snapshot(): Record<string, unknown>;
}

interface JsonStoreModule {
  JsonStore: {
    open(filePath: string): Promise<JsonStore>;
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
});
