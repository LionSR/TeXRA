// Node imports
import { spawnSync } from 'node:child_process';
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
import { repoPath } from '../desktop/desktopTestPaths.ts';

const verifierPath = repoPath('scripts/verify-desktop-package.mjs');
const extensionPackageUtilsUrl = pathToFileURL(
  repoPath('scripts/extension-package-utils.mjs'),
).href;

const { requiredMonacoWorkers } = (await import(extensionPackageUtilsUrl)) as {
  requiredMonacoWorkers: string[];
};

/**
 * Native CLI payloads that must never ship inside the packaged desktop app:
 * every one of these platform packages carries a 250-410 MiB binary, and the
 * app resolves a user-installed CLI at runtime instead.
 */
const nativeCliPlatformPackages = {
  codex: {
    packagePath: ['@openai', 'codex-darwin-arm64'],
    binaryPath: ['vendor', 'aarch64-apple-darwin', 'codex', 'codex'],
    pnpmStorePath: [
      '.pnpm',
      '@openai+codex@0.146.0-darwin-arm64',
      'node_modules',
      '@openai',
      'codex',
    ],
    pnpmBinaryPath: ['vendor', 'aarch64-apple-darwin', 'bin', 'codex'],
  },
  claude: {
    packagePath: ['@anthropic-ai', 'claude-agent-sdk-darwin-arm64'],
    binaryPath: ['claude'],
    pnpmStorePath: [
      '.pnpm',
      '@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.220',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-darwin-arm64',
    ],
    pnpmBinaryPath: ['claude'],
  },
} as const;

type NativeCliName = keyof typeof nativeCliPlatformPackages;

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe('desktop package native CLI payload', () => {
  it('passes when no Codex or Claude Code CLI payload is bundled', () => {
    const { packageRoot } = createFakeDesktopPackage();

    const result = runVerifier(packageRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      '- no bundled Codex or Claude Code CLI payload',
    );
  });

  it.each([
    { cli: 'codex' as const, label: 'OpenAI Codex CLI' },
    { cli: 'claude' as const, label: 'Claude Code CLI' },
  ])('fails when the $label platform package is bundled', ({ cli, label }) => {
    const { packageRoot, resourcesDir } = createFakeDesktopPackage();
    writeNativeCliPackage(resourcesDir, cli, 'package');

    const result = runVerifier(packageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bundles native CLI payloads');
    expect(result.stderr).toContain(label);
    expect(result.stderr).toContain('MiB');
  });

  it.each([{ cli: 'codex' as const }, { cli: 'claude' as const }])(
    'fails when the $cli payload is bundled through the pnpm store layout',
    ({ cli }) => {
      const { packageRoot, resourcesDir } = createFakeDesktopPackage();
      writeNativeCliPackage(resourcesDir, cli, 'pnpmStore');

      const result = runVerifier(packageRoot);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('bundles native CLI payloads');
    },
  );

  it('keeps the Codex and Claude Code SDKs out of desktop runtime dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(repoPath('packages/desktop/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // electron-builder copies the node_modules of production dependencies
    // only, so this is what keeps the native CLI binaries out of the app.
    for (const name of [
      '@openai/codex-sdk',
      '@anthropic-ai/claude-agent-sdk',
    ]) {
      expect(packageJson.dependencies ?? {}).not.toHaveProperty(name);
      expect(packageJson.devDependencies ?? {}).toHaveProperty(name);
    }
  });

  it('requires the trace-viewer template in packaged resources', () => {
    const { packageRoot, resourcesDir } = createFakeDesktopPackage();
    rmSync(join(resourcesDir, 'resources', 'traceViewer', 'index.html'));

    const result = runVerifier(packageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Missing trace-viewer HTML template: resources/traceViewer/index.html',
    );
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
    const { packageRoot } = createFakeDesktopPackage({
      startupImportPath: './bootstrap.js',
      bootstrapInputs: {
        'node_modules/.pnpm/openai@0.0.0/node_modules/openai/index.js': {
          bytesInOutput: 1,
        },
      },
    });

    const result = runVerifier(packageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Packaged desktop startup graph eagerly includes provider SDK code (OpenAI SDK)',
    );
  });
});

function createFakeDesktopPackage(
  options: {
    bootstrapInputs?: Record<string, { bytesInOutput: number }>;
    startupImportPath?: string;
  } = {},
): {
  packageRoot: string;
  resourcesDir: string;
} {
  const tempRoot = mkdtempSync(join(tmpdir(), 'texra-desktop-payload-'));
  tempRoots.push(tempRoot);

  const packageRoot = join(tempRoot, 'dist-packaged');
  const appRoot = join(
    packageRoot,
    'mac-arm64',
    'TeXRA.app',
    'Contents',
    'Resources',
    'app',
  );

  const desktopDependencies = readDesktopDependencies();
  writeJson(join(appRoot, 'package.json'), {
    main: './dist/main/index.js',
    dependencies: desktopDependencies,
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
  writeText(
    join(appRoot, 'resources/skills/example/SKILL.md'),
    'name: example\n\ndescription: Example bundled skill.\n',
  );
  writeText(
    join(appRoot, 'resources/traceViewer/index.html'),
    '<!doctype html>\n',
  );

  for (const dependencyName of Object.keys(desktopDependencies)) {
    writeJson(join(appRoot, 'node_modules', dependencyName, 'package.json'), {
      name: dependencyName,
      version: '0.0.0',
    });
  }

  return { packageRoot, resourcesDir: appRoot };
}

function writeNativeCliPackage(
  appRoot: string,
  cli: NativeCliName,
  layout: 'package' | 'pnpmStore',
): void {
  const info = nativeCliPlatformPackages[cli];
  const packageDir = join(
    appRoot,
    'app.asar.unpacked',
    'node_modules',
    ...(layout === 'pnpmStore' ? info.pnpmStorePath : info.packagePath),
  );

  writeJson(join(packageDir, 'package.json'), {
    name: info.packagePath.join('/'),
    version: '0.0.0',
  });
  writeBinary(
    join(
      packageDir,
      ...(layout === 'pnpmStore' ? info.pnpmBinaryPath : info.binaryPath),
    ),
  );
}

function runVerifier(packageRoot: string): {
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

/** A stand-in for a native CLI binary, large enough to report a MiB size. */
function writeBinary(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(2 * 1024 * 1024));
}
