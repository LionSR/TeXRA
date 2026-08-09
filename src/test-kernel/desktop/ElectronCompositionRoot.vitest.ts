// Node imports
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { sourceFilesUnder } from '@test/support/repoScan';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { normalizeFilePath } from '@utils/core';
import {
  DESKTOP_SRC_DIR,
  REPO_ROOT,
  desktopSourcePath,
  repoPath,
} from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

function namedImportSources(source: string, importedName: string): string[] {
  const bindingPattern = new RegExp(`\\b${importedName}\\b`, 'u');
  return [
    ...source.matchAll(
      /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu,
    ),
    ...source.matchAll(
      /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*\(?\s*(?:await\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)?/gu,
    ),
  ]
    .filter((match) => bindingPattern.test(match[1] ?? ''))
    .map((match) => match[2])
    .filter((specifier): specifier is string => specifier !== undefined);
}

function readDesktopMainIndex(): Promise<string> {
  return readFile(desktopSourcePath('main', 'index.ts'), 'utf8');
}

function readDesktopPlatformIndex(): Promise<string> {
  return readFile(desktopSourcePath('main', 'platform', 'index.ts'), 'utf8');
}

// Asserts each needle first occurs after the anchor, in the given order.
function expectOrderedAfter(
  source: string,
  anchor: string,
  needles: readonly string[],
): void {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex).toBeGreaterThanOrEqual(0);
  let previousIndex = anchorIndex;
  for (const needle of needles) {
    const index = source.indexOf(needle, anchorIndex);
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

describe('desktop composition root and launch environment', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  async function createResourceTree(resourcesPath: string): Promise<void> {
    await Promise.all([
      mkdir(join(resourcesPath, 'agents'), { recursive: true }),
      mkdir(join(resourcesPath, 'tool_use_agents'), { recursive: true }),
    ]);
  }

  it('owns one process session and flushes it before shutdown disposal', async () => {
    const source = await readDesktopMainIndex();

    expect(source.match(/new SessionHandle\(/gu)).toHaveLength(1);
    expect(source.match(/StreamLogStore\.openOrEphemeral\(\)/gu)).toHaveLength(
      1,
    );
    expect(source).toMatch(
      /createWindow\(\{[\s\S]*?\bprocessSession,[\s\S]*?\}\)/u,
    );
    expect(source).toContain('presentationSignal: presentationAbort.signal');

    expectOrderedAfter(source, 'installDesktopWindowTitle(', [
      'window.loadURL(',
    ]);
    expectOrderedAfter(source, 'installDesktopWindowTitle(', [
      'window.loadFile(',
    ]);
    expectOrderedAfter(source, "window.once('closed'", [
      'disposeWindowTitle()',
      'presentationAbort.abort()',
      'agentExecution.dispose()',
    ]);

    const shutdownBefore = source.indexOf(
      'lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE',
    );
    const disableResume = source.indexOf(
      'disposeAgentResumeHandler()',
      shutdownBefore,
    );
    const registerAgentShutdown = source.indexOf(
      'registerAgentShutdownHandlers(lifecycle)',
    );
    const flush = source.indexOf(
      'processSession.flushArtifacts()',
      registerAgentShutdown,
    );
    const shutdownStart = source.indexOf(
      'lifecycle.onShutdown(SHUTDOWN_PHASE.ON',
    );
    const disposeStores = source.indexOf(
      'disposeProcessStores()',
      shutdownStart,
    );
    const dispose = source.indexOf('processSession.dispose()', shutdownStart);
    expect(shutdownBefore).toBeGreaterThanOrEqual(0);
    expect(disableResume).toBeGreaterThan(shutdownBefore);
    expect(registerAgentShutdown).toBeGreaterThan(disableResume);
    expect(flush).toBeGreaterThan(registerAgentShutdown);
    expect(flush).toBeLessThan(shutdownStart);
    expect(shutdownStart).toBeGreaterThanOrEqual(0);
    expect(disposeStores).toBeGreaterThan(shutdownStart);
    expect(dispose).toBeGreaterThan(disposeStores);

    const initializeStores = source.indexOf(
      'await initializeDesktopProcessStores',
    );
    const registerStoreDisposer = source.indexOf(
      'disposeProcessStores = () => processStores.dispose()',
      initializeStores,
    );
    const awaitSessionRepair = source.indexOf(
      'await processSession.waitUntilReady()',
      initializeStores,
    );
    expect(initializeStores).toBeGreaterThanOrEqual(0);
    expect(registerStoreDisposer).toBeGreaterThan(initializeStores);
    expect(awaitSessionRepair).toBeGreaterThan(registerStoreDisposer);
  });

  it('imports process-store initialization directly from its owner', async () => {
    const source = await readDesktopMainIndex();
    expect(
      namedImportSources(source, 'initializeDesktopProcessStores'),
    ).toContain('./desktopProcessStores.js');
  });

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

  it('repairs PATH before platform services and bundled agents are initialized', async () => {
    const source = await readDesktopPlatformIndex();

    expect(source.indexOf('repairLaunchPath();')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('repairLaunchPath();')).toBeLessThan(
      source.indexOf('initPlatform('),
    );
    expect(source.indexOf('initPlatform(')).toBeLessThan(
      source.indexOf('bootstrapNodeAgentDirectories('),
    );
  });

  it('initializes desktop runtime skills from the resolved resource bundle', async () => {
    const source = await readDesktopPlatformIndex();

    expect(
      source.indexOf('const resourcesPath = resolveResourcesPath'),
    ).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('initializeNodeRuntimeSkills({')).toBeGreaterThan(
      source.indexOf('const resourcesPath = resolveResourcesPath'),
    );
    expect(source.indexOf('initializeNodeRuntimeSkills({')).toBeLessThan(
      source.indexOf('bootstrapNodeAgentDirectories('),
    );
  });

  it('uses the home directory as the no-workspace skill discovery fallback', async () => {
    const source = await readDesktopPlatformIndex();

    expect(source).toContain("cwd: workspacePath ?? app.getPath('home'),");
    expect(source).not.toContain('cwd: workspacePath ?? userDataPath,');
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
    let fixPathCalls = 0;
    const fixPath = () => {
      fixPathCalls += 1;
    };

    const first = repairLaunchPath({
      env,
      fixPath,
      platform: 'darwin',
    });
    const second = repairLaunchPath({
      env,
      fixPath,
      platform: 'darwin',
    });

    expect(first).toBe(second);
    expect(fixPathCalls).toBe(2);
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
        fixPath,
        platform: 'linux',
      }),
    ).toBe('/custom/bin');
  });

  it('does not call the process-level PATH fixer for injected environments', async () => {
    const { repairLaunchPath } = await loadSourceModule(
      '@desktop/main/platform/pathFix',
    );
    const processPath = process.env.PATH;
    const env = { PATH: '/custom/bin' };

    expect(
      repairLaunchPath({
        env,
        platform: 'darwin',
      }),
    ).toContain('/custom/bin');
    expect(process.env.PATH).toBe(processPath);
  });
});
