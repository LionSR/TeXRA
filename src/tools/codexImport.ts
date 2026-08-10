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

import * as path from 'node:path';

import { isModuleNotFoundError } from '@common/errors';
import { AbsoluteFS } from '@utils/files';
import { IS_WINDOWS } from '@utils/system/platformPaths';
import {
  createCachedBinaryResolver,
  resolveSdkExport,
} from './support/externalBinaryUtils';

// The native `Codex` class value; `typeof` gives its construct signature
// (`new (options?: CodexOptions) => Codex`) so construction stays type-checked.
type CodexConstructor = typeof import('@openai/codex-sdk').Codex;
type PlatformInfo = { pkg: string; triple: string };

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

  return resolveSdkExport<CodexConstructor>(mod, {
    exportName: 'Codex',
    specifier: '@openai/codex-sdk',
    errorLabel: 'Codex class',
  });
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

/** Native CLI binary filename for the current platform. */
const CODEX_BINARY_NAME = IS_WINDOWS ? 'codex.exe' : 'codex';

/**
 * Locate the native Codex binary inside a resolved platform-package directory.
 * The binary nests under `vendor/<triple>/codex/<binaryName>`.
 */
async function codexBinaryInPlatformPackage(
  platformPkgDir: string,
  platformInfo: PlatformInfo,
): Promise<string | undefined> {
  const binary = path.join(
    platformPkgDir,
    'vendor',
    platformInfo.triple,
    'codex',
    CODEX_BINARY_NAME,
  );
  return (await AbsoluteFS.exists(binary)) ? binary : undefined;
}

/**
 * Locate the native Codex CLI binary. Results are cached for the session
 * (misses are always retried so mid-session installs are picked up).
 *
 * The caller should pass the result as `codexPathOverride` to the Codex
 * constructor.
 */
export const findCodexBinaryPath = createCachedBinaryResolver(() => {
  const info = PLATFORM_INFO[`${process.platform}-${process.arch}`];
  if (!info) return undefined;

  return {
    platformPackages: [info.pkg],
    binaryInPlatformPackage: (dir) => codexBinaryInPlatformPackage(dir, info),
    // The npm global prefix hosts the `@openai/codex` meta-package; the
    // platform package is resolved relative to those roots.
    globalPrefixRoots: (prefix) => [
      path.join(prefix, 'lib', 'node_modules', '@openai', 'codex'),
      path.join(prefix, 'node_modules', '@openai', 'codex'),
    ],
    pathCommand: 'codex',
  };
});
