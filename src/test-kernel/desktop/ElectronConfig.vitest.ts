// Node imports
import { access } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { describe, expect } from 'vitest';

// Local imports - platform
import type { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import type { JsonStore } from '@platform/defaults/jsonStore';

// Local imports - test support
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { loadSourceModule } from './loadSourceModule.ts';

describe('desktop JsonConfigProvider (dual-store)', () => {
  const tempDirs = useTempDirs();

  function createProvider(): Effect.Effect<
    {
      provider: JsonConfigProvider;
      globalStore: JsonStore;
      workspaceStore: JsonStore;
      files: readonly string[];
    },
    SyntaxError
  > {
    return Effect.gen(function* () {
      const [{ JsonStore }, { JsonConfigProvider }] = yield* Effect.promise(
        () =>
          Promise.all([
            loadSourceModule('@platform/defaults/jsonStore'),
            loadSourceModule('@platform/defaults/jsonConfigProvider'),
          ]),
      );
      const tempDir = yield* Effect.promise(() =>
        makeTempDir('texra-electron-config-', tempDirs),
      );
      const globalPath = join(tempDir, 'global.json');
      const workspacePath = join(tempDir, 'workspace.json');
      const [globalStore, workspaceStore] = yield* Effect.all([
        JsonStore.open(globalPath),
        JsonStore.open(workspacePath),
      ]);
      return {
        provider: new JsonConfigProvider({
          workspace: workspaceStore,
          global: globalStore,
        }),
        globalStore,
        workspaceStore,
        files: [globalPath, workspacePath],
      };
    });
  }

  it.effect('returns schema defaults without creating empty config files', () =>
    Effect.gen(function* () {
      const { provider, files } = yield* createProvider();
      for (const file of files) {
        const exit = yield* Effect.exit(Effect.promise(() => access(file)));
        expect(Exit.isFailure(exit)).toBe(true);
      }

      expect(provider.get('texra.bib.zoteroPort')).toBe(23119);
      expect(provider.inspect('texra.bib.zoteroPort')).toStrictEqual({
        globalValue: undefined,
        workspaceValue: undefined,
      });
      for (const file of files) {
        const exit = yield* Effect.exit(Effect.promise(() => access(file)));
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect('returns isolated copies of mutable schema defaults', () =>
    Effect.gen(function* () {
      const { provider } = yield* createProvider();
      const key = 'texra.latex.enabledReplacements';
      const first = provider.get<string[]>(key);

      first.push('mutated');

      expect(provider.get<string[]>(key)).not.toContain('mutated');
    }),
  );

  it.effect('lets workspace values override global values', () =>
    Effect.gen(function* () {
      const { provider, globalStore, workspaceStore } = yield* createProvider();
      yield* globalStore.set('texra.files.exclude', ['dist']);
      yield* workspaceStore.set('texra.files.exclude', ['node_modules']);

      expect(provider.get('files.exclude', [])).toEqual(['node_modules']);
      expect(provider.inspect('files.exclude')).toEqual({
        globalValue: ['dist'],
        workspaceValue: ['node_modules'],
      });
    }),
  );

  it.effect('updates existing canonical keys', () =>
    Effect.gen(function* () {
      const { provider, workspaceStore } = yield* createProvider();
      yield* workspaceStore.set('texra.files.exclude', ['dist']);

      yield* Effect.promise(() =>
        provider.update('files.exclude', ['node_modules']),
      );

      expect(workspaceStore.snapshot()).toEqual({
        'texra.files.exclude': ['node_modules'],
      });
    }),
  );

  it.effect('stores new config values under the canonical prefixed key', () =>
    Effect.gen(function* () {
      const { provider, workspaceStore } = yield* createProvider();

      yield* Effect.promise(() =>
        provider.update('files.exclude', ['node_modules']),
      );

      expect(provider.get('files.exclude', [])).toEqual(['node_modules']);
      expect(provider.get('texra.files.exclude', [])).toEqual(['node_modules']);
      expect(workspaceStore.snapshot()).toEqual({
        'texra.files.exclude': ['node_modules'],
      });
    }),
  );

  it.effect('clears the stored value when a config value is unset', () =>
    Effect.gen(function* () {
      const { provider, workspaceStore } = yield* createProvider();
      yield* workspaceStore.set('texra.files.exclude', ['node_modules']);

      yield* Effect.promise(() => provider.update('files.exclude', undefined));

      expect(provider.isExplicitlySet('files.exclude')).toBe(false);
      expect(workspaceStore.snapshot()).toEqual({});
    }),
  );
});
