// Node imports
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports - platform
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import {
  MEMORY_STORAGE_DIR,
  WorkspaceStorageProvider,
  resolveGlobalStoragePath,
  resolveMemoryStoragePath,
  resolveRunOriginalSnapshotPath,
  resolveRunStoragePath,
  resolveWorkspaceStoragePath,
  RUNS_STORAGE_DIR,
  workspaceStorageId,
} from '@platform/defaults/workspaceStorage';
import { pathExists } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('workspace storage defaults', () => {
  const tempDirs = useTempDirs();

  function makeStorageRoot(): Promise<string> {
    return makeTempDir('texra-workspace-storage-', tempDirs);
  }

  it('computes a stable workspace storage identity', () => {
    expect(workspaceStorageId('/workspace/a')).toMatch(/^a-[0-9a-f]{8}$/);
    expect(workspaceStorageId('/workspace/a')).toBe(
      workspaceStorageId('  /workspace/a  '),
    );
    expect(workspaceStorageId('/workspace/a')).not.toBe(
      workspaceStorageId('/workspace/b'),
    );
    expect(workspaceStorageId('/workspace/b')).toMatch(/^b-[0-9a-f]{8}$/);
    expect(workspaceStorageId(undefined)).toBe(workspaceStorageId(''));
    expect(workspaceStorageId(undefined)).toMatch(/^no-workspace-[0-9a-f]{8}$/);
  });

  it('snapshots global, workspace, memory, and run storage layout paths', async () => {
    const root = await makeStorageRoot();
    const workspacePath = '/workspace/a';

    expect([
      resolveGlobalStoragePath(root),
      resolveWorkspaceStoragePath(root, workspacePath),
      MEMORY_STORAGE_DIR,
      resolveMemoryStoragePath('memories/project.md'),
      RUNS_STORAGE_DIR,
      resolveRunStoragePath('run-1', 'result.json'),
      resolveRunOriginalSnapshotPath('run-1', 'Draft/Draft.tex'),
    ]).toEqual([
      join(root, 'v1', 'global-storage'),
      join(root, 'v1', 'workspace-storage', workspaceStorageId(workspacePath)),
      'memories',
      'memories/project.md',
      'executions',
      'executions/run-1/result.json',
      'executions/run-1/original/Draft/Draft.tex',
    ]);
    expect(() => resolveMemoryStoragePath('not-memories/project.md')).toThrow(
      'Invalid memory path',
    );
  });

  it('normalizes logical memory paths independently of the host separator', () => {
    expect(resolveMemoryStoragePath('memories/./project.md')).toBe(
      'memories/project.md',
    );
    expect(resolveMemoryStoragePath(String.raw`memories\project.md`)).toBe(
      'memories/project.md',
    );
  });

  it.each(['memories/../outside', String.raw`memories\..\outside`])(
    'rejects memory path traversal: %s',
    (storagePath) => {
      expect(() => resolveMemoryStoragePath(storagePath)).toThrow(
        'Invalid memory path',
      );
    },
  );

  it.live(
    'opens fresh state without changing old project or global storage',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeStorageRoot);
        const workspacePath = '/workspace/Legacy Project';
        const oldPaths = [
          join(root, 'workspace-storage', 'dda160810e1d2a9f'),
          join(root, 'workspace-storage', workspaceStorageId(workspacePath)),
          join(root, 'global-storage'),
        ];
        const oldBytes = Buffer.from('existing state\n\u0000unchanged');
        for (const oldPath of oldPaths) {
          yield* Effect.promise(() => mkdir(oldPath, { recursive: true }));
          yield* Effect.promise(() =>
            writeFile(join(oldPath, 'state.json'), oldBytes),
          );
        }
        const provider = new WorkspaceStorageProvider(root, workspacePath);
        const storagePath = provider.getStoragePath();
        const globalPath = provider.getGlobalStoragePath();
        expect(storagePath).toBe(
          join(
            root,
            'v1',
            'workspace-storage',
            workspaceStorageId(workspacePath),
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

  // Regression pin (#C4): a malformed project config used to fail CLI startup
  // outright — `JsonStore.open` throws and only the GUI hosts caught it. Every
  // host now degrades to the internal workspace store, loudly.
  it.effect(
    'degrades to the internal workspace config store when the project config is malformed',
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
        const storage = createNodeStorageProvider({
          storageRoot: root,
          workspacePath,
        });
        const warnings: string[] = [];

        const stores = yield* openTexraConfigStores(
          storage,
          workspacePath,
          (m) => warnings.push(m),
        );
        yield* stores.workspace.set('texra.files.exclude', ['dist']);

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Cannot open project .texra/config.json');
        expect(
          yield* Effect.promise(() =>
            pathExists(join(storage.getStoragePath(), 'config.json')),
          ),
        ).toBe(true);
      }),
  );
});
