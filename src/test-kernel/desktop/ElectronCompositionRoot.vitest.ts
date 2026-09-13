import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, FileSystem } from 'effect';
import { it as effectIt } from '@effect/vitest';

import { describe, expect, it, vi } from 'vitest';
import * as agentRuntime from '@agent/runtime';
import { openDesktopProjectRegistry } from '@desktop/main/desktopProjects.js';
import { openDesktopProjectRecords } from '@desktop/main/desktopProjectRecords.js';
import { JsonStore } from '@platform/defaults/jsonStore';
import {
  nodeProcesses,
  processOwnerId,
} from '@platform/defaults/nodeProcesses';
import { createFakeHost } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

import { sourceFilesUnder } from '@test/support/repoScan';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { normalizeFilePath } from '@utils/core';
import {
  DESKTOP_SRC_DIR,
  REPO_ROOT,
  desktopSourcePath,
} from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

function readDesktopMainIndex(): Promise<string> {
  return readFile(desktopSourcePath('main', 'index.ts'), 'utf8');
}

function readDesktopBootstrap(): Promise<string> {
  return readFile(desktopSourcePath('main', 'bootstrap.ts'), 'utf8');
}

describe('desktop composition root and launch environment', () => {
  const tempDirs = useTempDirs();

  async function createResourceTree(resourcesPath: string): Promise<void> {
    await Promise.all([
      mkdir(join(resourcesPath, 'agents'), { recursive: true }),
      mkdir(join(resourcesPath, 'tool_use_agents'), { recursive: true }),
    ]);
  }

  effectIt.live(
    'reopens the ordered project record without reading or changing earlier profile state',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const profile = yield* fs.makeTempDirectoryScoped({
            prefix: 'texra-project-records-',
          });
          const oldState = join(profile, 'state', 'global.json');
          const previous = '{"texra.desktop.openPapers":["earlier-project"]}';
          yield* fs.makeDirectory(join(profile, 'state'));
          yield* fs.writeFileString(oldState, previous);
          const owner = processOwnerId(
            yield* Effect.promise(() => nodeProcesses.selfIdentity()),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const records = yield* openDesktopProjectRecords(profile, owner);
              expect(yield* records.read).toEqual([]);
              yield* Effect.all(
                [records.remember('/first'), records.remember('/second')],
                { concurrency: 'unbounded' },
              );
              yield* records.activate('/first');
              yield* records.forget('/second');
            }),
          );
          const reopened = yield* openDesktopProjectRecords(profile, owner);
          expect(yield* reopened.read).toEqual(['/first']);
          expect(yield* fs.readFileString(oldState)).toBe(previous);
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  effectIt.live(
    'keeps a project registered when saving its closure fails',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const profile = yield* fs.makeTempDirectoryScoped({
            prefix: 'texra-close-project-',
          });
          const root = join(profile, 'project');
          yield* fs.makeDirectory(root);
          const opener = vi
            .spyOn(agentRuntime, 'openSessionEffect')
            .mockImplementation((init) =>
              Effect.sync(() =>
                createTestSession({
                  ...init,
                  transcriptMode: {
                    kind: 'ephemeral',
                    reason: 'project close regression',
                  },
                }),
              ),
            );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => opener.mockRestore()),
          );
          const owner = processOwnerId(
            yield* Effect.promise(() => nodeProcesses.selfIdentity()),
          );
          const records = yield* openDesktopProjectRecords(profile, owner);
          const config = yield* JsonStore.open(join(profile, 'config.json'));
          const host = createFakeHost({
            storagePath: join(profile, 'no-project'),
          });
          const registry = yield* openDesktopProjectRegistry({
            dataRoot: profile,
            processRoots: host.roots,
            globalConfigStore: config,
            records,
            runWrite: (write) => Effect.runPromise(write),
            stores: {
              secrets: host.secrets,
              globalState: host.roots.globalState,
            },
            warn: vi.fn(),
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => registry.dispose()),
          );
          const successorRoot = join(profile, 'successor');
          yield* fs.makeDirectory(successorRoot);
          const successor = yield* registry.open(successorRoot);
          const project = yield* registry.open(root);
          yield* registry.activate(project.root);
          const remembered = yield* records.read;
          const disposed = vi.spyOn(project, 'dispose');
          const failure = new Error('Unable to save project closure');
          vi.spyOn(records, 'forget').mockReturnValueOnce(Effect.fail(failure));
          expect(yield* Effect.flip(registry.close(project.root!))).toBe(
            failure,
          );
          expect(registry.list()).toContain(project);
          expect(registry.active()).toBe(project);
          expect(disposed).not.toHaveBeenCalled();
          expect(yield* records.read).toEqual(remembered);
          yield* registry.close(project.root!);
          expect(registry.list()).not.toContain(project);
          expect(disposed).toHaveBeenCalledOnce();
          expect(registry.active()).toBe(successor);
          expect(yield* records.read).toEqual([successor.root]);
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it('keeps platform initialization in the Electron composition root', async () => {
    const files = sourceFilesUnder(DESKTOP_SRC_DIR);
    const initPlatformFiles: string[] = [];

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf8');
      if (source.includes('initPlatform(')) {
        initPlatformFiles.push(
          normalizeFilePath(relative(REPO_ROOT, filePath)),
        );
      }
    }

    expect(initPlatformFiles).toEqual([
      'packages/desktop/src/main/platform/index.ts',
    ]);
  });

  it('shares the CLI ~/.texra data root by default, isolating only under the e2e override (#7987)', async () => {
    const { resolveDesktopDataRoot } = await loadSourceModule(
      '@desktop/main/platform/paths',
    );
    const userDataPath = '/tmp/some-electron-user-data';

    expect(resolveDesktopDataRoot(userDataPath, { env: {} })).toBe(
      join(homedir(), '.texra'),
    );
    expect(
      resolveDesktopDataRoot(userDataPath, {
        env: { TEXRA_DESKTOP_E2E_USER_DATA_PATH: userDataPath },
      }),
    ).toBe(userDataPath);
  });

  it('finds resources in packaged and monorepo development layouts', async () => {
    const { resolveResourcesPath } = await loadSourceModule(
      '@desktop/main/platform/paths',
    );
    const root = await makeTempDir('texra-electron-root-', tempDirs);
    const appResources = join(root, 'app', 'resources');
    const packagedResources = join(root, 'electron-resources', 'resources');
    const monorepoResources = join(root, 'packages', 'extension', 'resources');
    const mainDirname = join(root, 'packages', 'desktop', 'dist', 'main');

    await Promise.all(
      [appResources, packagedResources, monorepoResources].map(
        createResourceTree,
      ),
    );

    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'app'),
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(appResources);
    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'missing-app'),
        resourcesPath: join(root, 'electron-resources'),
      }),
    ).toBe(packagedResources);
    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'missing-app'),
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(monorepoResources);
  });

  it('requires bundled agent sources to be directories', async () => {
    const { resolveResourcesPath } = await loadSourceModule(
      '@desktop/main/platform/paths',
    );
    const root = await makeTempDir('texra-electron-root-', tempDirs);
    const incompleteApp = join(root, 'incomplete-app');
    const fileBackedApp = join(root, 'file-backed-app');
    const monorepoResources = join(root, 'packages', 'extension', 'resources');
    const mainDirname = join(root, 'packages', 'desktop', 'dist', 'main');

    await Promise.all([
      mkdir(join(incompleteApp, 'resources', 'agents'), { recursive: true }),
      mkdir(join(fileBackedApp, 'resources', 'agents'), { recursive: true }),
      createResourceTree(monorepoResources),
    ]);
    await writeFile(join(fileBackedApp, 'resources', 'tool_use_agents'), '');

    expect(
      resolveResourcesPath(mainDirname, {
        appPath: fileBackedApp,
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(monorepoResources);
    expect(
      resolveResourcesPath(mainDirname, {
        appPath: incompleteApp,
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(monorepoResources);
  });

  it('throws with every checked resource candidate when resources are missing', async () => {
    const { resolveResourcesPath } = await loadSourceModule(
      '@desktop/main/platform/paths',
    );
    const root = await makeTempDir('texra-electron-root-', tempDirs);
    const mainDirname = join(root, 'packages', 'desktop', 'dist', 'main');

    expect(() =>
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'app'),
        resourcesPath: join(root, 'electron-resources'),
      }),
    ).toThrow(
      [
        join(root, 'app', 'resources'),
        join(root, 'electron-resources', 'resources'),
        join(root, 'packages', 'extension', 'resources'),
        join(root, 'resources'),
      ].join(', '),
    );
  });

  it('repairs macOS launch PATH idempotently without changing non-macOS PATH', async () => {
    const { repairLaunchPath } = await loadSourceModule(
      '@desktop/main/platform/pathFix',
    );
    const env = { PATH: '/custom/bin:/usr/bin' };

    const first = repairLaunchPath({
      env,
      platform: 'darwin',
    });
    const second = repairLaunchPath({
      env,
      platform: 'darwin',
    });

    expect(first).toBe(second);
    expect(second.split(':')).toEqual([
      '/Library/TeX/texbin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/custom/bin',
      '/usr/bin',
    ]);

    const linuxEnv = { PATH: '/custom/bin' };
    expect(
      repairLaunchPath({
        env: linuxEnv,
        platform: 'linux',
      }),
    ).toBe('/custom/bin');
  });
});
