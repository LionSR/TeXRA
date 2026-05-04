// Node imports
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { loadDesktopPlatformModule } from './loadDesktopPlatformModule';

interface PathFixModule {
  repairLaunchPathWithOptions(options?: {
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
      resourcesPath?: string;
    },
  ): string;
  resolveWorkspacePath(options?: {
    env?: { TEXRA_WORKSPACE_PATH?: string };
  }): string | undefined;
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

  it('keeps platform initialization in the Electron composition root', async () => {
    const desktopMainDir = join(process.cwd(), 'packages', 'desktop', 'src');
    const files = await walkTypeScriptFiles(desktopMainDir);
    const initPlatformFiles: string[] = [];

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf8');
      if (source.includes('initPlatform(')) {
        initPlatformFiles.push(relative(process.cwd(), filePath));
      }
    }

    expect(initPlatformFiles).toEqual([
      'packages/desktop/src/main/platform/index.ts',
    ]);
  });

  it('repairs PATH before platform services and bundled agents are initialized', async () => {
    const source = await readFile(
      join(
        process.cwd(),
        'packages',
        'desktop',
        'src',
        'main',
        'platform',
        'index.ts',
      ),
      'utf8',
    );

    expect(source.indexOf('repairLaunchPath();')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('repairLaunchPath();')).toBeLessThan(
      source.indexOf('initPlatform({'),
    );
    expect(source.indexOf('initPlatform({')).toBeLessThan(
      source.indexOf('bootstrapElectronAgentDirectories('),
    );
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

  it('does not accept resource directories missing bundled agent sources', async () => {
    const { resolveResourcesPath } =
      await loadDesktopPlatformModule<PathsModule>('paths.ts');
    const root = await makeTempDir();
    const incompleteResources = join(root, 'configured-resources');
    const monorepoResources = join(root, 'packages', 'extension', 'resources');
    const mainDirname = join(root, 'packages', 'desktop', 'dist', 'main');

    await Promise.all([
      mkdir(join(incompleteResources, 'agents'), { recursive: true }),
      createResourceTree(monorepoResources),
    ]);

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
      ].join(', '),
    );
  });

  it('repairs macOS launch PATH idempotently without changing non-macOS PATH', async () => {
    const { repairLaunchPathWithOptions } =
      await loadDesktopPlatformModule<PathFixModule>('pathFix.ts');
    const env = { PATH: '/custom/bin:/usr/bin' };
    let fixPathCalls = 0;
    const fixPath = () => {
      fixPathCalls += 1;
    };

    const first = repairLaunchPathWithOptions({
      env,
      fixPath,
      platform: 'darwin',
    });
    const second = repairLaunchPathWithOptions({
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
      repairLaunchPathWithOptions({
        env: linuxEnv,
        fixPath,
        platform: 'linux',
      }),
    ).toBe('/custom/bin');
  });
});
