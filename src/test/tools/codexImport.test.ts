// Node.js built-in imports
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Local imports - tools
import { findCodexBinaryInElectronResources } from '@tools/codexImport';

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

describe('findCodexBinaryInElectronResources', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir != null) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('finds the platform binary under app.asar.unpacked resources', async function (this: Mocha.Context) {
    const platformPackage =
      PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
    if (platformPackage == null) {
      this.skip();
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

    assert.equal(await findCodexBinaryInElectronResources(tempDir), binaryPath);
  });
});
