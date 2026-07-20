// Node imports
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { DESKTOP_SRC_DIR, REPO_ROOT, repoPath } from './desktopTestPaths.mjs';
import { loadDesktopPlatformModule } from './loadDesktopPlatformModule.mjs';

interface PathFixModule {
  repairLaunchPath(options?: {
    env?: { PATH?: string };
    fixPath?: () => void;
    platform?: NodeJS.Platform;
  }): string;
}

interface PathsModule {
  resolveResourcesPath(
    mainDirname: string,
    options?: {
      appPath?: string;
      env?: { TEXRA_RESOURCES_PATH?: string };
      isDirectory?: (path: string) => boolean;
      resourcesPath?: string;
    },
  ): string;
  resolveWorkspacePath(options?: {
    env?: { TEXRA_WORKSPACE_PATH?: string };
  }): string | undefined;
  resolveDesktopDataRoot(
    userDataPath: string,
    options?: { env?: { TEXRA_DESKTOP_E2E_USER_DATA_PATH?: string } },
  ): string;
}

async function walkTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTypeScriptFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

describe('desktop composition root and launch environment', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function makeTempDir(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-electron-root-'));
    return tempDir;
  }

  async function createResourceTree(resourcesPath: string): Promise<void> {
    await Promise.all([
      mkdir(join(resourcesPath, 'agents'), { recursive: true }),
      mkdir(join(resourcesPath, 'tool_use_agents'), { recursive: true }),
    ]);
  }

  it('owns one process session and flushes it before shutdown disposal', async () => {
    const source = await readFile(
      repoPath('packages', 'desktop', 'src', 'main', 'index.ts'),
      'utf8',
    );

    expect(source.match(/new SessionHandle\(/gu)).toHaveLength(1);
    expect(source.match(/StreamLogStore\.open\(\)/gu)).toHaveLength(1);
    expect(source).toMatch(
      /createWindow\(\{[\s\S]*?\bprocessSession,[\s\S]*?\}\)/u,
    );
    expect(source).toContain('presentationSignal: presentationAbort.signal');

    const windowClose = source.indexOf("window.once('closed'");
    const abortPresentation = source.indexOf(
      'presentationAbort.abort()',
      windowClose,
    );
    const disposePresentation = source.indexOf(
      'agentExecution.dispose()',
      windowClose,
    );
    expect(abortPresentation).toBeGreaterThan(windowClose);
    expect(disposePresentation).toBeGreaterThan(abortPresentation);

    const shutdownStart = source.indexOf(
      'lifecycle.onShutdown(SHUTDOWN_PHASE.ON',
    );
    const flush = source.indexOf(
      'await processSession.flushArtifacts()',
      shutdownStart,
    );
    const disposeStores = source.indexOf(
      'disposeProcessStores()',
      shutdownStart,
    );
    const dispose = source.indexOf('processSession.dispose()', shutdownStart);
    expect(shutdownStart).toBeGreaterThanOrEqual(0);
    expect(flush).toBeGreaterThan(shutdownStart);
    expect(disposeStores).toBeGreaterThan(flush);
    expect(dispose).toBeGreaterThan(disposeStores);

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
    expect(shutdownBefore).toBeGreaterThanOrEqual(0);
    expect(disableResume).toBeGreaterThan(shutdownBefore);
    expect(registerAgentShutdown).toBeGreaterThan(disableResume);
  });

  it('keeps platform initialization in the Electron composition root', async () => {
    const files = await walkTypeScriptFiles(DESKTOP_SRC_DIR);
    const initPlatformFiles: string[] = [];

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf8');
      if (source.includes('initPlatform(')) {
        initPlatformFiles.push(relative(REPO_ROOT, filePath));
      }
    }

    expect(initPlatformFiles).toEqual([
      'packages/desktop/src/main/platform/index.ts',
    ]);
  });

  it('repairs PATH before platform services and bundled agents are initialized', async () => {
    const source = await readFile(
      repoPath('packages', 'desktop', 'src', 'main', 'platform', 'index.ts'),
      'utf8',
    );

    expect(source.indexOf('repairLaunchPath();')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('repairLaunchPath();')).toBeLessThan(
      source.indexOf('initPlatform('),
    );
    expect(source.indexOf('initPlatform(')).toBeLessThan(
      source.indexOf('bootstrapNodeAgentDirectories('),
    );
  });

  it('initializes desktop runtime skills from the resolved resource bundle', async () => {
    const source = await readFile(
      repoPath('packages', 'desktop', 'src', 'main', 'platform', 'index.ts'),
      'utf8',
    );

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
    const source = await readFile(
      repoPath('packages', 'desktop', 'src', 'main', 'platform', 'index.ts'),
      'utf8',
    );

    expect(source).toContain("cwd: workspacePath ?? app.getPath('home'),");
    expect(source).not.toContain('cwd: workspacePath ?? userDataPath,');
  });

  it('resolves workspace paths only from an explicit launch environment', async () => {
    const { resolveWorkspacePath } =
      await loadDesktopPlatformModule<PathsModule>('paths.ts');

    expect(
      resolveWorkspacePath({
        env: { TEXRA_WORKSPACE_PATH: ' ./project ' },
      }),
    ).toBe(resolve('./project'));
    expect(
      resolveWorkspacePath({ env: { TEXRA_WORKSPACE_PATH: '   ' } }),
    ).toBeUndefined();
  });

  it('shares the CLI ~/.texra data root by default, isolating only under the e2e override (#7987)', async () => {
    const { resolveDesktopDataRoot } =
      await loadDesktopPlatformModule<PathsModule>('paths.ts');
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

  it('finds resources in configured, packaged, and monorepo development layouts', async () => {
    const { resolveResourcesPath } =
      await loadDesktopPlatformModule<PathsModule>('paths.ts');
    const root = await makeTempDir();
    const configuredResources = join(root, 'configured-resources');
    const appResources = join(root, 'app', 'resources');
    const packagedResources = join(root, 'electron-resources', 'resources');
    const monorepoResources = join(root, 'packages', 'extension', 'resources');
    const mainDirname = join(root, 'packages', 'desktop', 'dist', 'main');

    await Promise.all(
      [
        configuredResources,
        appResources,
        packagedResources,
        monorepoResources,
      ].map(createResourceTree),
    );

    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'missing-app'),
        env: { TEXRA_RESOURCES_PATH: configuredResources },
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(configuredResources);
    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'app'),
        env: {},
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(appResources);
    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'missing-app'),
        env: {},
        resourcesPath: join(root, 'electron-resources'),
      }),
    ).toBe(packagedResources);
    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'missing-app'),
        env: {},
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(monorepoResources);
  });

  it('requires bundled agent sources to be directories', async () => {
    const { resolveResourcesPath } =
      await loadDesktopPlatformModule<PathsModule>('paths.ts');
    const root = await makeTempDir();
    const incompleteResources = join(root, 'configured-resources');
    const fileBackedResources = join(root, 'file-backed-resources');
    const monorepoResources = join(root, 'packages', 'extension', 'resources');
    const mainDirname = join(root, 'packages', 'desktop', 'dist', 'main');

    await Promise.all([
      mkdir(join(incompleteResources, 'agents'), { recursive: true }),
      mkdir(join(fileBackedResources, 'agents'), { recursive: true }),
      createResourceTree(monorepoResources),
    ]);
    await writeFile(join(fileBackedResources, 'tool_use_agents'), '');

    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'missing-app'),
        env: { TEXRA_RESOURCES_PATH: fileBackedResources },
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(monorepoResources);
    expect(
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'missing-app'),
        env: { TEXRA_RESOURCES_PATH: incompleteResources },
        resourcesPath: join(root, 'missing-electron-resources'),
      }),
    ).toBe(monorepoResources);
  });

  it('throws with every checked resource candidate when resources are missing', async () => {
    const { resolveResourcesPath } =
      await loadDesktopPlatformModule<PathsModule>('paths.ts');
    const root = await makeTempDir();
    const mainDirname = join(root, 'packages', 'desktop', 'dist', 'main');

    expect(() =>
      resolveResourcesPath(mainDirname, {
        appPath: join(root, 'app'),
        env: { TEXRA_RESOURCES_PATH: join(root, 'configured') },
        resourcesPath: join(root, 'electron-resources'),
      }),
    ).toThrow(
      [
        join(root, 'configured'),
        join(root, 'app', 'resources'),
        join(root, 'electron-resources', 'resources'),
        join(root, 'packages', 'extension', 'resources'),
        join(root, 'resources'),
      ].join(', '),
    );
  });

  it('repairs macOS launch PATH idempotently without changing non-macOS PATH', async () => {
    const { repairLaunchPath } =
      await loadDesktopPlatformModule<PathFixModule>('pathFix.ts');
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
    const { repairLaunchPath } =
      await loadDesktopPlatformModule<PathFixModule>('pathFix.ts');
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
