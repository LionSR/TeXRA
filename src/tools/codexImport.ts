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

import { createRequire } from 'node:module';
import * as path from 'node:path';

import { isModuleNotFoundError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { executeCommand } from '@utils/system/execUtils';
import { IS_WINDOWS } from '@utils/system/platformPaths';

import { CODEX_CLI_MODEL } from './codexConfig';
import {
  createCachedBinaryResolver,
  resolveSdkExport,
} from './support/externalBinaryUtils';

const log = createLog('codexImport');
const codexXhighSupportByBinary = new Map<string, boolean>();
const codexXhighProbes = new Map<string, Promise<boolean>>();

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
 * Locate the native Codex binary inside a resolved package directory.
 * Current packages use `vendor/<triple>/bin/<binaryName>`; the second
 * candidate keeps older installs usable. When `platformPkgDir` is the
 * `@openai/codex` meta-package, follow its nested platform package.
 */
async function codexBinaryInPlatformPackage(
  platformPkgDir: string,
  platformInfo: PlatformInfo,
): Promise<string | undefined> {
  const findInPlatformPackage = async (
    packageDir: string,
  ): Promise<string | undefined> => {
    const vendorDir = path.join(packageDir, 'vendor', platformInfo.triple);
    const candidates = [
      path.join(vendorDir, 'bin', CODEX_BINARY_NAME),
      path.join(vendorDir, 'codex', CODEX_BINARY_NAME),
    ];
    for (const candidate of candidates) {
      if (await AbsoluteFS.exists(candidate)) return candidate;
    }
    return undefined;
  };

  const direct = await findInPlatformPackage(platformPkgDir);
  if (direct) return direct;

  try {
    const nestedPackageJson = createRequire(
      path.join(platformPkgDir, 'package.json'),
    ).resolve(`${platformInfo.pkg}/package.json`);
    return await findInPlatformPackage(path.dirname(nestedPackageJson));
  } catch {
    // Platform package not resolvable
    return undefined;
  }
}

type BundledCodexModel = {
  slug?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
};

function catalogSupportsXhigh(
  stdout: string,
  model: string,
): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed == null || !('models' in parsed)) {
      return undefined;
    }
    const models = (parsed as { models: unknown }).models;
    if (!Array.isArray(models)) return undefined;
    const entry = models.find(
      (item): item is BundledCodexModel =>
        typeof item === 'object' &&
        item != null &&
        (item as BundledCodexModel).slug === model,
    );
    if (entry == null) return false;
    return (entry.supported_reasoning_levels ?? []).some(
      (level) => level.effort === 'xhigh',
    );
  } catch {
    return undefined;
  }
}

/**
 * Probe whether the resolved Codex runtime reports `xhigh` for the pinned
 * CLI model. Timeouts and spawn failures are not cached so a later call
 * retries instead of permanently capping Extra High to High.
 */
export async function codexBinarySupportsXhigh(
  binaryPath: string | undefined,
): Promise<boolean> {
  if (!binaryPath) return false;

  const cached = codexXhighSupportByBinary.get(binaryPath);
  if (cached != null) return cached;

  const inflight = codexXhighProbes.get(binaryPath);
  if (inflight) return inflight;

  const probe = (async (): Promise<boolean> => {
    const result = await executeCommand(
      [binaryPath, 'debug', 'models', '--bundled'],
      { quiet: true, timeout: 5_000, cwd: process.cwd() },
    );
    if (result.timedOut || result.exitCode === 127) {
      log.warn('Codex xhigh capability probe failed; not caching the result', {
        data: {
          binaryPath,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      });
      return false;
    }
    if (!result.success) {
      codexXhighSupportByBinary.set(binaryPath, false);
      return false;
    }
    const supported = catalogSupportsXhigh(result.stdout, CODEX_CLI_MODEL);
    if (supported == null) {
      log.warn('Codex xhigh capability probe returned unreadable catalog', {
        data: { binaryPath },
      });
      return false;
    }
    codexXhighSupportByBinary.set(binaryPath, supported);
    return supported;
  })().finally(() => {
    codexXhighProbes.delete(binaryPath);
  });

  codexXhighProbes.set(binaryPath, probe);
  return probe;
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
    platformPackages: [info.pkg, '@openai/codex'],
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
