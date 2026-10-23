// Node imports
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports - platform
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { nodePlatformLayer, pathExists } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { openTexraConfigStores } from '@texra/platform/defaults/nodeStores';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';

describe('workspace storage defaults', () => {
  const tempDirs = useTempDirs();

  function makeStorageRoot(): Promise<string> {
    return makeTempDir('texra-workspace-storage-', tempDirs);
  }

  // The workspace storage identity, read off the path calculator that owns it.
  function storageIdOf(
    root: string,
    workspacePath: string | undefined,
  ): string {
    return basename(resolveWorkspaceStoragePath(root, workspacePath));
  }

  it('computes a stable workspace storage identity', async () => {
    const root = await makeStorageRoot();
    expect(storageIdOf(root, '/workspace/a')).toMatch(/^a-[0-9a-f]{8}$/);
    expect(storageIdOf(root, '/workspace/a')).toBe(
      storageIdOf(root, '  /workspace/a  '),
    );
    expect(storageIdOf(root, '/workspace/a')).not.toBe(
      storageIdOf(root, '/workspace/b'),
    );
    expect(storageIdOf(root, '/workspace/b')).toMatch(/^b-[0-9a-f]{8}$/);
    expect(storageIdOf(root, undefined)).toBe(storageIdOf(root, ''));
    expect(storageIdOf(root, undefined)).toMatch(/^no-workspace-[0-9a-f]{8}$/);
  });

  it('snapshots global and workspace storage layout paths', async () => {
    const root = await makeStorageRoot();
    const workspacePath = '/workspace/a';

    expect([
      resolveGlobalStoragePath(root),
      resolveWorkspaceStoragePath(root, workspacePath),
    ]).toEqual([
      join(root, 'v1', 'global-storage'),
      join(root, 'v1', 'workspace-storage', storageIdOf(root, workspacePath)),
    ]);
  });

  it.live(
    'opens fresh state without changing old project or global storage',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeStorageRoot);
        const workspacePath = '/workspace/Legacy Project';
        const oldPaths = [
          join(root, 'workspace-storage', 'dda160810e1d2a9f'),
          join(root, 'workspace-storage', storageIdOf(root, workspacePath)),
          join(root, 'global-storage'),
        ];
        const oldBytes = Buffer.from('existing state\n\u0000unchanged');
        for (const oldPath of oldPaths) {
          yield* Effect.promise(() => mkdir(oldPath, { recursive: true }));
          yield* Effect.promise(() =>
            writeFile(join(oldPath, 'state.json'), oldBytes),
          );
        }
        const storagePath = resolveWorkspaceStoragePath(root, workspacePath);
        const globalPath = resolveGlobalStoragePath(root);
        for (const created of [storagePath, globalPath]) {
          yield* Effect.promise(() => mkdir(created, { recursive: true }));
        }
        expect(storagePath).toBe(
          join(
            root,
            'v1',
            'workspace-storage',
            storageIdOf(root, workspacePath),
          ),
        );
        expect(globalPath).toBe(join(root, 'v1', 'global-storage'));
        expect(yield* Effect.promise(() => readdir(storagePath))).toEqual([]);
        expect(yield* Effect.promise(() => readdir(globalPath))).toEqual([]);
        yield* Effect.promise(() =>
          writeFile(join(storagePath, 'state.json'), 'new project state'),
        );
        yield* Effect.promise(() =>
          writeFile(join(globalPath, 'state.json'), 'new global state'),
        );
        for (const oldPath of oldPaths) {
          expect(yield* Effect.promise(() => readdir(oldPath))).toEqual([
            'state.json',
          ]);
          expect(
            yield* Effect.promise(() => readFile(join(oldPath, 'state.json'))),
          ).toEqual(oldBytes);
        }
      }),
  );

  // Regression pin: a malformed project config used to fail CLI startup
  // outright. Every host now opens it as an empty view, loudly, and never
  // moves the workspace config to a second home.
  it.effect(
    'warns and refuses writes when the project config is malformed',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => makeStorageRoot());
        const workspacePath = yield* Effect.promise(() =>
          makeTempDir('texra-project-', tempDirs),
        );
        yield* Effect.promise(() =>
          mkdir(join(workspacePath, '.texra'), { recursive: true }),
        );
        yield* Effect.promise(() =>
          writeFile(join(workspacePath, '.texra', 'config.json'), '{ broken'),
        );
        const warnings: string[] = [];

        const stores = yield* openTexraConfigStores(
          TEXRA_SETTINGS,
          root,
          workspacePath,
          (m: string) => warnings.push(m),
        );
        const write = yield* Effect.exit(
          stores.workspace.set('texra.files.exclude', ['dist']),
        );

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Cannot read');
        expect(write._tag).toBe('Failure');
        expect(
          yield* Effect.promise(() =>
            pathExists(
              join(
                resolveWorkspaceStoragePath(root, workspacePath),
                'config.json',
              ),
            ),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
