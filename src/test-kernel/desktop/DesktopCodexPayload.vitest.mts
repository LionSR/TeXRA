// Node imports
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

const verifierPath = repoPath('scripts/verify-desktop-package.mjs');
const payloadUrl = pathToFileURL(
  repoPath('scripts/desktop-codex-payload.mjs'),
).href;
const pruneHookUrl = pathToFileURL(
  repoPath('scripts/prune-desktop-codex-payload.mjs'),
).href;
const desktopPruneHookUrl = pathToFileURL(
  repoPath('packages/desktop/scripts/prune-desktop-codex-payload.mjs'),
).href;
const extensionPackageUtilsUrl = pathToFileURL(
  repoPath('scripts/extension-package-utils.mjs'),
).href;

const { requiredMonacoWorkers } = (await import(extensionPackageUtilsUrl)) as {
  requiredMonacoWorkers: string[];
};

const codexPlatforms = {
  'darwin-arm64': {
    packageName: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
    binaryName: 'codex',
  },
  'darwin-x64': {
    packageName: '@openai/codex-darwin-x64',
    triple: 'x86_64-apple-darwin',
    binaryName: 'codex',
  },
} as const;

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe('desktop Codex package payload', () => {
  it('fails arch-specific package verification when an extra Codex platform package is bundled', () => {
    const { packageRoot } = createFakeDesktopPackage([
      'darwin-arm64',
      'darwin-x64',
    ]);

    const result = runVerifierResult(packageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'bundles extra Codex CLI platform packages',
    );
  });

  it('prunes unused Codex platform packages before verification', () => {
    const { appOutDir, packageRoot, resourcesDir } = createFakeDesktopPackage([
      'darwin-arm64',
      'darwin-x64',
    ]);

    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const { default: prune } = await import(${JSON.stringify(
          pruneHookUrl,
        )}); await prune({ electronPlatformName: 'darwin', arch: 3, appOutDir: ${JSON.stringify(
          appOutDir,
        )}, packager: { getResourcesDir: () => ${JSON.stringify(resourcesDir)} } });`,
      ],
      { encoding: 'utf8' },
    );

    const output = runVerifier(packageRoot);
    expect(output).toContain('@openai/codex-darwin-arm64');
    expect(output).not.toContain('@openai/codex-darwin-x64');
    expect(output).toContain('Codex CLI payload size');
  });

  it('verifies the aliased pnpm Codex package layout', () => {
    const { packageRoot, resourcesDir } = createFakeDesktopPackage([]);
    writePnpmCodexPlatformPackage(resourcesDir, 'darwin-arm64');

    const output = runVerifier(packageRoot);
    expect(output).toContain('@openai/codex-darwin-arm64');
    expect(output).toContain('Codex CLI payload size');
  });

  it('does not infer Windows from a darwin path segment', async () => {
    const { inferCodexPlatformKeys } = (await import(payloadUrl)) as {
      inferCodexPlatformKeys: (input: { appPath: string }) => string[];
    };

    expect(
      inferCodexPlatformKeys({
        appPath: '/tmp/TeXRA-darwin-arm64/TeXRA.app',
      }),
    ).toEqual(['darwin-arm64']);
  });

  it('infers architecture from path tokens nearest the app bundle', async () => {
    const { inferCodexPlatformKeys } = (await import(payloadUrl)) as {
      inferCodexPlatformKeys: (input: {
        appPath: string;
        arch?: number;
        platform?: string;
      }) => string[];
    };

    expect(
      inferCodexPlatformKeys({
        appPath: '/tmp/arm64-compat-lib/dist/mac-x64/TeXRA.app',
      }),
    ).toEqual(['darwin-x64']);
    expect(
      inferCodexPlatformKeys({
        appPath: '/tmp/universal-cache/dist/mac-arm64/TeXRA.app',
      }),
    ).toEqual(['darwin-arm64']);
    expect(
      inferCodexPlatformKeys({
        platform: 'darwin',
        arch: 1,
        appPath: '/tmp/universal-cache/dist/TeXRA.app',
      }),
    ).toEqual(['darwin-x64']);
  });

  it('defaults Linux and Windows package paths without architecture tokens to x64', async () => {
    const { inferCodexPlatformKeys } = (await import(payloadUrl)) as {
      inferCodexPlatformKeys: (input: { appPath: string }) => string[];
    };

    expect(
      inferCodexPlatformKeys({
        appPath: '/tmp/dist/linux-unpacked/resources/app.asar',
      }),
    ).toEqual(['linux-x64']);
    expect(
      inferCodexPlatformKeys({
        appPath: '/tmp/dist/win-unpacked/resources/app.asar',
      }),
    ).toEqual(['win32-x64']);
  });

  it('uses the universal Codex payload budget only for universal builds', async () => {
    const { expectedCodexPayloadBudgetBytes, inferCodexPlatformKeys } =
      (await import(payloadUrl)) as {
        expectedCodexPayloadBudgetBytes: (platformKeys: string[]) => number;
        inferCodexPlatformKeys: (input: { appPath: string }) => string[];
      };

    const singlePlatformBudget = expectedCodexPayloadBudgetBytes(
      inferCodexPlatformKeys({
        appPath: '/tmp/universal-cache/dist/mac-arm64/TeXRA.app',
      }),
    );
    const universalBudget = expectedCodexPayloadBudgetBytes(
      inferCodexPlatformKeys({
        appPath: '/tmp/dist/mac-universal/TeXRA.app',
      }),
    );

    expect(universalBudget).toBeGreaterThan(singlePlatformBudget);
  });

  it('keeps both Darwin Codex packages during universal temp packaging', async () => {
    const { inferCodexPlatformKeys } = (await import(payloadUrl)) as {
      inferCodexPlatformKeys: (input: {
        arch: number;
        appPath: string;
        platform: string;
      }) => string[];
    };

    expect(
      inferCodexPlatformKeys({
        platform: 'darwin',
        arch: 1,
        appPath:
          '/tmp/dist-packaged/mac-universal-x64-temp/TeXRA.app/Contents/Resources',
      }),
    ).toEqual(['darwin-x64', 'darwin-arm64']);
  });

  it('loads the desktop-local electron-builder pruning hook', async () => {
    const rootHook = await import(pruneHookUrl);
    const desktopHook = await import(desktopPruneHookUrl);

    expect(desktopHook.default).toBe(rootHook.default);
  });

  it('keeps pnpm platform settings in the workspace manifest', () => {
    const rootPackageJson = JSON.parse(
      readFileSync(repoPath('package.json'), 'utf8'),
    ) as { pnpm?: unknown };
    const workspaceYaml = readFileSync(repoPath('pnpm-workspace.yaml'), 'utf8');

    expect(rootPackageJson.pnpm).toBeUndefined();
    expect(workspaceYaml).toContain('supportedArchitectures:');
    expect(workspaceYaml).toContain('  cpu:');
    expect(workspaceYaml).toContain('    - x64');
    expect(workspaceYaml).toContain('    - arm64');
  });

  it('resolves relative metafile imports from the importing output directory', () => {
    const { packageRoot } = createFakeDesktopPackage(['darwin-arm64'], {
      startupImportPath: './bootstrap.js',
      bootstrapInputs: {
        'node_modules/.pnpm/openai@0.0.0/node_modules/openai/index.js': {
          bytesInOutput: 1,
        },
      },
    });

    const result = runVerifierResult(packageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Packaged desktop startup graph eagerly includes provider SDK code (OpenAI SDK)',
    );
  });
});

function createFakeDesktopPackage(
  platforms: Array<keyof typeof codexPlatforms>,
  options: {
    bootstrapInputs?: Record<string, { bytesInOutput: number }>;
    startupImportPath?: string;
  } = {},
): {
  appOutDir: string;
  packageRoot: string;
  resourcesDir: string;
} {
  const tempRoot = mkdtempSync(join(tmpdir(), 'texra-desktop-codex-'));
  tempRoots.push(tempRoot);

  const packageRoot = join(tempRoot, 'dist-packaged');
  const appOutDir = join(packageRoot, 'mac-arm64');
  const resourcesDir = join(appOutDir, 'TeXRA.app', 'Contents', 'Resources');
  const appRoot = join(resourcesDir, 'app');

  writeJson(join(appRoot, 'package.json'), {
    main: './dist/main/index.js',
    dependencies: readDesktopDependencies(),
  });
  writeText(join(appRoot, 'dist/main/index.js'), "import './bootstrap.js';\n");
  writeText(join(appRoot, 'dist/main/bootstrap.js'), 'export {};\n');
  writeJson(join(appRoot, 'dist/main/metafile.json'), {
    outputs: {
      'dist/main/index.js': {
        entryPoint: 'src/main/index.ts',
        inputs: {
          'src/main/index.ts': {
            bytesInOutput: 1,
          },
        },
        imports: [
          {
            path: options.startupImportPath ?? 'dist/main/bootstrap.js',
            kind: 'import-statement',
          },
        ],
      },
      'dist/main/bootstrap.js': {
        inputs: options.bootstrapInputs ?? {
          'src/main/bootstrap.ts': {
            bytesInOutput: 1,
          },
        },
        imports: [],
      },
    },
  });
  writeText(join(appRoot, 'dist/preload/index.cjs'), "'use strict';\n");
  writeText(join(appRoot, 'dist/renderer/index.html'), '<!doctype html>\n');
  writeText(join(appRoot, 'dist/renderer/assets/app.js'), 'export {};\n');
  writeText(join(appRoot, 'dist/renderer/assets/app.css'), ':root {}\n');
  for (const workerName of requiredMonacoWorkers) {
    writeText(
      join(appRoot, 'dist/renderer/assets', `${workerName}-fake.js`),
      'self.onmessage = () => {};\n',
    );
  }
  writeText(join(appRoot, 'resources/agents/example.yaml'), 'name: example\n');
  writeText(
    join(appRoot, 'resources/tool_use_agents/example.yaml'),
    'name: example\n',
  );

  for (const dependencyName of Object.keys(readDesktopDependencies())) {
    writeJson(join(appRoot, 'node_modules', dependencyName, 'package.json'), {
      name: dependencyName,
      version: '0.0.0',
    });
  }

  for (const platform of platforms) {
    writeCodexPlatformPackage(appRoot, platform);
  }

  return { appOutDir, packageRoot, resourcesDir: appRoot };
}

function writeCodexPlatformPackage(
  appRoot: string,
  platform: keyof typeof codexPlatforms,
): void {
  const info = codexPlatforms[platform];
  const packageRoot = join(
    appRoot,
    'app.asar.unpacked',
    'node_modules',
    ...info.packageName.split('/'),
  );

  writeJson(join(packageRoot, 'package.json'), {
    name: '@openai/codex',
    version: `0.128.0-${platform}`,
  });
  writeText(
    join(packageRoot, 'vendor', info.triple, 'codex', info.binaryName),
    'fake codex binary\n',
  );
}

function writePnpmCodexPlatformPackage(
  appRoot: string,
  platform: keyof typeof codexPlatforms,
): void {
  const info = codexPlatforms[platform];
  const packageRoot = join(
    appRoot,
    'app.asar.unpacked',
    'node_modules',
    '.pnpm',
    `@openai+codex@0.133.0-${platform}`,
    'node_modules',
    '@openai',
    'codex',
  );

  writeJson(join(packageRoot, 'package.json'), {
    name: '@openai/codex',
    version: `0.133.0-${platform}`,
  });
  writeText(
    join(packageRoot, 'vendor', info.triple, 'bin', info.binaryName),
    'fake codex binary\n',
  );
}

function runVerifier(packageRoot: string): string {
  return execFileSync(process.execPath, [verifierPath], {
    cwd: repoPath('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TEXRA_DESKTOP_PACKAGE_ROOT: packageRoot,
    },
  });
}

function runVerifierResult(packageRoot: string): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const result = spawnSync(process.execPath, [verifierPath], {
    cwd: repoPath('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TEXRA_DESKTOP_PACKAGE_ROOT: packageRoot,
    },
  });

  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function readDesktopDependencies(): Record<string, string> {
  const packageJson = JSON.parse(
    readFileSync(repoPath('packages/desktop/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  return packageJson.dependencies ?? {};
}

function writeJson(path: string, data: unknown): void {
  writeText(path, `${JSON.stringify(data, null, 2)}\n`);
}

function writeText(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
