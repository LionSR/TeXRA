// Node imports
import { mkdtemp, rm } from 'node:fs/promises';
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

interface JsonConfigProvider {
  get<T>(key: string, defaultValue?: T): T;
  inspect<T = unknown>(
    key: string,
  ):
    | {
        globalValue?: T;
        workspaceValue?: T;
        effectiveValue?: T;
      }
    | undefined;
  update<T>(
    key: string,
    value: T,
    target?: 'global' | 'workspace',
  ): Promise<void>;
  isExplicitlySet(key: string): boolean;
  watch(key: string, listener: () => void): { dispose(): void };
}

interface JsonStoreModule {
  JsonStore: {
    open(filePath: string): Promise<JsonStore>;
  };
}

interface JsonConfigProviderModule {
  JsonConfigProvider: new (
    workspaceStore: JsonStore,
    globalStore?: JsonStore,
  ) => JsonConfigProvider;
}

async function loadDesktopConfigConstructors(): Promise<{
  JsonStore: JsonStoreModule['JsonStore'];
  JsonConfigProvider: JsonConfigProviderModule['JsonConfigProvider'];
}> {
  const [{ JsonStore }, { JsonConfigProvider }] = await Promise.all([
    loadPlatformDefaultsModule<JsonStoreModule>('jsonStore.ts'),
    loadPlatformDefaultsModule<JsonConfigProviderModule>(
      'jsonConfigProvider.ts',
    ),
  ]);
  return { JsonStore, JsonConfigProvider };
}

describe('desktop JsonConfigProvider (dual-store)', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function createProvider(): Promise<{
    provider: JsonConfigProvider;
    globalStore: JsonStore;
    workspaceStore: JsonStore;
  }> {
    const { JsonStore, JsonConfigProvider } =
      await loadDesktopConfigConstructors();
    tempDir = await mkdtemp(join(tmpdir(), 'texra-electron-config-'));
    const globalStore = await JsonStore.open(join(tempDir, 'global.json'));
    const workspaceStore = await JsonStore.open(
      join(tempDir, 'workspace.json'),
    );
    return {
      provider: new JsonConfigProvider(workspaceStore, globalStore),
      globalStore,
      workspaceStore,
    };
  }

  it('lets workspace values override global values across config aliases', async () => {
    const { provider, globalStore, workspaceStore } = await createProvider();
    await globalStore.set('files.exclude', ['dist']);
    await workspaceStore.set('texra.files.exclude', ['node_modules']);

    expect(provider.get('files.exclude', [])).toEqual(['node_modules']);
    expect(provider.inspect('files.exclude')).toEqual({
      globalValue: ['dist'],
      workspaceValue: ['node_modules'],
      effectiveValue: ['node_modules'],
    });
  });

  it('updates existing alias keys instead of leaving stale shadow entries', async () => {
    const { provider, workspaceStore } = await createProvider();
    await workspaceStore.set('texra.files.exclude', ['dist']);

    await provider.update('files.exclude', ['node_modules']);

    expect(workspaceStore.snapshot()).toEqual({
      'texra.files.exclude': ['node_modules'],
    });
  });

  it('stores new config values under the canonical prefixed key', async () => {
    const { provider, workspaceStore } = await createProvider();

    await provider.update('files.exclude', ['node_modules']);

    expect(provider.get('files.exclude', [])).toEqual(['node_modules']);
    expect(provider.get('texra.files.exclude', [])).toEqual(['node_modules']);
    expect(workspaceStore.snapshot()).toEqual({
      'texra.files.exclude': ['node_modules'],
    });
  });

  it('updates an existing shorthand key from a prefixed alias', async () => {
    const { provider, workspaceStore } = await createProvider();
    await workspaceStore.set('files.exclude', ['dist']);

    await provider.update('texra.files.exclude', ['node_modules']);

    expect(provider.get('files.exclude', [])).toEqual(['node_modules']);
    expect(workspaceStore.snapshot()).toEqual({
      'files.exclude': ['node_modules'],
    });
  });

  it('clears every stored alias when a config value is unset', async () => {
    const { provider, workspaceStore } = await createProvider();
    await workspaceStore.set('files.exclude', ['dist']);
    await workspaceStore.set('texra.files.exclude', ['node_modules']);

    await provider.update('files.exclude', undefined);

    expect(provider.isExplicitlySet('files.exclude')).toBe(false);
    expect(workspaceStore.snapshot()).toEqual({});
  });

  it('notifies watchers registered under either config alias', async () => {
    const { provider } = await createProvider();
    let prefixedChanges = 0;
    let unprefixedChanges = 0;

    provider.watch('texra.files.exclude', () => {
      prefixedChanges += 1;
    });
    provider.watch('files.exclude', () => {
      unprefixedChanges += 1;
    });

    await provider.update('files.exclude', ['node_modules']);
    await provider.update('texra.files.exclude', ['dist']);

    expect(prefixedChanges).toBe(2);
    expect(unprefixedChanges).toBe(2);
  });
});
