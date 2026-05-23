/**
 * Helpers for the Codex tool.
 *
 * 1. `importCodexClass()` — import the Codex constructor from @openai/codex-sdk.
 *    The SDK is bundled into CJS by esbuild at build time, so no runtime
 *    ESM/CJS workarounds are needed.
 *
 * 2. `findCodexBinaryPath()` — locate the native Codex CLI binary. The SDK
 *    bundles its own `findCodexPath()` but it resolves `@openai/codex`
 *    relative to the SDK itself (inside the VSIX). Since we don't ship the
 *    130 MB platform binaries in the VSIX, we probe Electron's unpacked app
 *    resources, local node_modules, the global npm prefix, and PATH (in that
 *    priority order), then return the path for `codexPathOverride`. Results
 *    are cached for the session.
 */

import { createRequire } from 'module';
import * as path from 'path';

import { isModuleNotFoundError } from '@common/errors';
import { platform } from '@platform/platform';
import { executeCommandSync } from '@utils/system/execUtils';

type CodexConstructor = new (options?: any) => any;
type PlatformInfo = { pkg: string; triple: string };
type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

// ---------------------------------------------------------------------------
// SDK import
// ---------------------------------------------------------------------------

/**
 * Import the Codex class from @openai/codex-sdk.
 *
 * The SDK is ESM-only, but esbuild converts it to CJS at build time (it must
 * NOT be listed in esbuild's `external` array). The dynamic import() here is
 * converted to require() by esbuild, so it works in VS Code's extension host.
 */
export async function importCodexClass(): Promise<CodexConstructor> {
  let mod: Record<string, unknown>;
  try {
    mod = await import('@openai/codex-sdk');
  } catch (err: unknown) {
    if (isModuleNotFoundError(err)) {
      throw new Error(
        '@openai/codex-sdk package not found. Install with: npm install -g @openai/codex',
      );
    }
    throw err;
  }

  // esbuild CJS output: named exports are direct properties.
  // Handle possible interop shapes just in case.
  const Codex =
    mod.Codex ??
    (mod.default as Record<string, unknown> | undefined)?.Codex ??
    mod.default;

  if (typeof Codex !== 'function') {
    const keys = Object.keys(mod).join(', ');
    throw new Error(
      `Codex class not found in @openai/codex-sdk. Module keys: [${keys}]. ` +
        'Ensure @openai/codex-sdk is NOT in esbuild externals.',
    );
  }

  return Codex as CodexConstructor;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** Platform key → npm package name and target triple for the native binary. */
const PLATFORM_INFO: Record<string, PlatformInfo> = {
  'linux-x64': {
    pkg: '@openai/codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
  },
  'linux-arm64': {
    pkg: '@openai/codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
  },
  'darwin-x64': {
    pkg: '@openai/codex-darwin-x64',
    triple: 'x86_64-apple-darwin',
  },
  'darwin-arm64': {
    pkg: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
  },
  'win32-x64': {
    pkg: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
  },
  'win32-arm64': {
    pkg: '@openai/codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
  },
};

/** Cached result — found paths are cached; misses are retried. */
let cachedBinaryPath: string | undefined;

/**
 * Locate the native Codex CLI binary. Results are cached for the session
 * (misses are always retried so mid-session installs are picked up).
 *
 * The caller should pass the result as `codexPathOverride` to the Codex
 * constructor.
 */
export async function findCodexBinaryPath(): Promise<string | undefined> {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath;

  const result = await findCodexBinaryPathUncached();
  if (result) cachedBinaryPath = result;
  return result;
}

async function findCodexBinaryPathUncached(): Promise<string | undefined> {
  const info = PLATFORM_INFO[`${process.platform}-${process.arch}`];
  if (!info) return undefined;

  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';

  // Strategy 1: packaged Electron app.asar.unpacked resources
  // Highest priority when present — packaged apps cannot execute binaries
  // from inside app.asar.
  {
    const resourcesPath = getPackagedElectronResourcesPath();
    const result =
      resourcesPath == null
        ? undefined
        : await findCodexBinaryInElectronResources(resourcesPath);
    if (result) return result;
  }

  // Strategy 2: resolve from local project's node_modules
  // Preferred in VS Code extension development — matches package.json.
  {
    const result = await resolveCodexBinary(
      path.join(__dirname, '..'),
      info,
      binaryName,
    );
    if (result) return result;
  }

  // Strategy 3: resolve from global npm prefix
  // Preferred over PATH because the npm-installed binary matches the SDK.
  {
    const prefixResult = executeCommandSync(['npm', 'prefix', '-g'], {
      timeout: 5000,
    });
    const prefix = prefixResult.success ? prefixResult.stdout : undefined;

    if (prefix) {
      const roots = [
        path.join(prefix, 'lib', 'node_modules', '@openai', 'codex'),
        path.join(prefix, 'node_modules', '@openai', 'codex'),
      ];

      for (const codexPkgDir of roots) {
        const result = await resolveCodexBinary(codexPkgDir, info, binaryName);
        if (result) return result;
      }
    }
  }

  // Strategy 4: PATH lookup (Homebrew, manual install, etc.)
  // Fallback — may find an older version that doesn't match the SDK.
  {
    const lookupResult = executeCommandSync(
      [process.platform === 'win32' ? 'where' : 'which', 'codex'],
      {
        timeout: 5000,
      },
    );
    const pathHits = lookupResult.success
      ? (lookupResult.stdout ?? '').split(/\r?\n/)
      : [];

    for (const hit of pathHits) {
      const p = hit.trim();
      if (!p) continue;
      // The SDK spawns the binary directly, so skip shell-only npm shims.
      if (process.platform === 'win32' && /\.(cmd|ps1)$/i.test(p)) continue;
      if (await pathExists(p)) return p;
    }
  }

  return undefined;
}

/**
 * Locate Codex inside an Electron packaged app's unpacked resources directory.
 *
 * `resourcesPath` should be Electron's `process.resourcesPath`; the expected
 * binary location is:
 *
 *   resources/app.asar.unpacked/node_modules/@openai/<platform-package>/...
 */
export async function findCodexBinaryInElectronResources(
  resourcesPath: string,
): Promise<string | undefined> {
  const info = PLATFORM_INFO[`${process.platform}-${process.arch}`];
  if (!info) return undefined;

  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const platformPkgDir = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    ...info.pkg.split('/'),
  );

  return resolveCodexBinaryFromPlatformPackage(
    platformPkgDir,
    info,
    binaryName,
  );
}

function getPackagedElectronResourcesPath(): string | undefined {
  const electronProcess = process as ElectronProcess;
  if (electronProcess.versions.electron == null) return undefined;
  if (electronProcess.defaultApp === true) return undefined;
  return electronProcess.resourcesPath;
}

/**
 * Resolve the native Codex binary from a directory that contains (or nests)
 * the platform-specific package.  Returns the binary path if found, or
 * `undefined`.
 *
 * Works for both a direct `@openai/codex` package dir and any ancestor
 * that Node module resolution can traverse from.
 */
async function resolveCodexBinary(
  baseDir: string,
  platformInfo: PlatformInfo,
  binaryName: string,
): Promise<string | undefined> {
  try {
    const req = createRequire(path.join(baseDir, 'package.json'));
    const platformPkgJson = req.resolve(`${platformInfo.pkg}/package.json`);
    const binary = await resolveCodexBinaryFromPlatformPackage(
      path.dirname(platformPkgJson),
      platformInfo,
      binaryName,
    );
    if (binary) return binary;
  } catch {
    // Platform package not resolvable
  }
  return undefined;
}

async function resolveCodexBinaryFromPlatformPackage(
  platformPkgDir: string,
  platformInfo: PlatformInfo,
  binaryName: string,
): Promise<string | undefined> {
  const binary = path.join(
    platformPkgDir,
    'vendor',
    platformInfo.triple,
    'codex',
    binaryName,
  );
  return (await pathExists(binary)) ? binary : undefined;
}

async function pathExists(target: string): Promise<boolean> {
  return platform()
    .fs.stat(target)
    .then(() => true)
    .catch(() => false);
}
