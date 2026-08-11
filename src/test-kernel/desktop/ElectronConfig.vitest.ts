// Node imports
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - platform
import type { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import type { JsonStore } from '@platform/defaults/jsonStore';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.ts';

async function loadDesktopConfigConstructors(): Promise<{
  JsonStore: typeof import('@platform/defaults/jsonStore').JsonStore;
  JsonConfigProvider: typeof import('@platform/defaults/jsonConfigProvider').JsonConfigProvider;
}> {
  const [{ JsonStore }, { JsonConfigProvider }] = await Promise.all([
    loadSourceModule('@platform/defaults/jsonStore'),
    loadSourceModule('@platform/defaults/jsonConfigProvider'),
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
      provider: new JsonConfigProvider({
        workspace: workspaceStore,
        global: globalStore,
      }),
      globalStore,
      workspaceStore,
    };
  }

  it('lets workspace values override global values', async () => {
    const { provider, globalStore, workspaceStore } = await createProvider();
    await globalStore.set('texra.files.exclude', ['dist']);
    await workspaceStore.set('texra.files.exclude', ['node_modules']);

    expect(provider.get('files.exclude', [])).toEqual(['node_modules']);
    expect(provider.inspect('files.exclude')).toEqual({
      globalValue: ['dist'],
      workspaceValue: ['node_modules'],
    });
  });

  it('updates existing canonical keys', async () => {
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

  it('clears the stored value when a config value is unset', async () => {
    const { provider, workspaceStore } = await createProvider();
    await workspaceStore.set('texra.files.exclude', ['node_modules']);

    await provider.update('files.exclude', undefined);

    expect(provider.isExplicitlySet('files.exclude')).toBe(false);
    expect(workspaceStore.snapshot()).toEqual({});
  });

  it('canonicalizes watcher keys supplied through the configuration API', async () => {
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
