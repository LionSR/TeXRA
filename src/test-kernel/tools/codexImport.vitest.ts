// Node imports
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { describe, it, afterEach } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import { findCodexBinaryPath } from '@tools/codexImport';

const PLATFORM_PACKAGES: Record<
  string,
  { pkg: string; triple: string; binaryName: string }
> = {
  'linux-x64': {
    pkg: '@openai/codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    binaryName: 'codex',
  },
  'linux-arm64': {
    pkg: '@openai/codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
    binaryName: 'codex',
  },
  'darwin-x64': {
    pkg: '@openai/codex-darwin-x64',
    triple: 'x86_64-apple-darwin',
    binaryName: 'codex',
  },
  'darwin-arm64': {
    pkg: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
    binaryName: 'codex',
  },
  'win32-x64': {
    pkg: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    binaryName: 'codex.exe',
  },
  'win32-arm64': {
    pkg: '@openai/codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    binaryName: 'codex.exe',
  },
};

describe('findCodexBinaryPath', () => {
  let tempDir: string | undefined;

  // pathExists() probes the real filesystem through platform().fs.
  setupPlatform({}, { fs: nodeFilesystem });

  afterEach(() => {
    if (tempDir != null) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('finds the platform binary under app.asar.unpacked resources', async (ctx) => {
    const platformPackage =
      PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
    if (platformPackage == null) {
      ctx.skip();
      return;
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resources-'));
    const binaryPath = path.join(
      tempDir,
      'app.asar.unpacked',
      'node_modules',
      ...platformPackage.pkg.split('/'),
      'vendor',
      platformPackage.triple,
      'codex',
      platformPackage.binaryName,
    );
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, '');

    // Impersonate a packaged Electron app: the resolver's highest-priority
    // probe reads process.versions.electron, process.defaultApp, and
    // process.resourcesPath.
    const electronProcess = process as NodeJS.Process & {
      defaultApp?: boolean;
      resourcesPath?: string;
    };
    Object.defineProperty(process.versions, 'electron', {
      value: '30.0.0',
      configurable: true,
      enumerable: true,
    });
    electronProcess.resourcesPath = tempDir;
    try {
      assert.equal(await findCodexBinaryPath(), binaryPath);
    } finally {
      Reflect.deleteProperty(process.versions, 'electron');
      Reflect.deleteProperty(electronProcess, 'resourcesPath');
    }
  });
});
