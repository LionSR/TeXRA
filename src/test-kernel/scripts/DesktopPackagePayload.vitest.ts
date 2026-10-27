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

const verifierPath = repoPath('scripts/verify-desktop.mjs');
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
  },
  claude: {
    packagePath: ['@anthropic-ai', 'claude-agent-sdk-darwin-arm64'],
    binaryPath: ['claude'],
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
  it.each([
    { cli: 'codex' as const, label: 'OpenAI Codex CLI' },
    { cli: 'claude' as const, label: 'Claude Code CLI' },
  ])('fails when the $label platform package is bundled', ({ cli, label }) => {
    const { packageRoot, resourcesDir } = createFakeDesktopPackage();
    writeNativeCliPackage(resourcesDir, cli);

    const result = runVerifier(packageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(label);
  });
});

function createFakeDesktopPackage(): {
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
            path: 'dist/main/bootstrap.js',
            kind: 'import-statement',
          },
        ],
      },
      'dist/main/bootstrap.js': {
        inputs: { 'src/main/bootstrap.ts': { bytesInOutput: 1 } },
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
  writeText(join(appRoot, 'serve/texra-serve.mjs'), 'export {};\n');
  writeText(join(appRoot, 'resources/agents/example.yaml'), 'name: example\n');
  writeText(
    join(appRoot, 'resources/skills/example/SKILL.md'),
    'name: example\n\ndescription: Example bundled skill.\n',
  );
  writeText(
    join(appRoot, 'resources/plugins/example/skills/example/SKILL.md'),
    'name: example\n\ndescription: Example plugin skill.\n',
  );
  writeText(
    join(appRoot, 'resources/plugins/lean4/agents/example.yaml'),
    'name: example\n',
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

function writeNativeCliPackage(appRoot: string, cli: NativeCliName): void {
  const info = nativeCliPlatformPackages[cli];
  const packageDir = join(
    appRoot,
    'app.asar.unpacked',
    'node_modules',
    ...info.packagePath,
  );

  writeJson(join(packageDir, 'package.json'), {
    name: info.packagePath.join('/'),
    version: '0.0.0',
  });
  writeBinary(join(packageDir, ...info.binaryPath));
}

function runVerifier(packageRoot: string) {
  return spawnSync(process.execPath, [verifierPath, 'package'], {
    cwd: repoPath('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TEXRA_DESKTOP_PACKAGE_ROOT: packageRoot,
    },
  });
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
