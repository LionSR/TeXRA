/**
 * Shared utilities for the Claude Code and Codex CLI vendor tools, which ship
 * their SDKs and native binaries as npm platform packages
 * (e.g. @anthropic-ai/claude-agent-sdk-*, @openai/codex-*).
 *
 * Both tools follow the same shapes and would otherwise drift:
 * - `resolveSdkExport()` — resolve and validate the SDK's main export across
 *   the ESM/CJS interop shapes esbuild can produce.
 * - `resolveBinary()` — the 4-strategy native-binary probe, plus the identical
 *   Electron-detection and path-existence helpers it needs.
 * - `createCachedBinaryResolver()` — the per-session cache wrapper around
 *   `resolveBinary`.
 *
 * NOTE: the `await import('<specifier>')` that loads each SDK stays inline in
 * the tool files on purpose — esbuild only rewrites dynamic `import()` to
 * `require()` when the specifier is a static string literal, so it cannot be
 * hoisted here. Only the post-import export resolution is shared.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';

import { AbsoluteFS } from '@utils/files/absoluteFS';
import { executeCommandSync } from '@utils/system/execUtils';
import { IS_WINDOWS } from '@utils/system/platformPaths';

type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

/**
 * Returns Electron's `process.resourcesPath` when running inside a packaged
 * Electron application. Returns `undefined` in development mode
 * (`defaultApp === true`) and in non-Electron runtimes (VS Code extension
 * host, plain Node.js).
 */
function getPackagedElectronResourcesPath(): string | undefined {
  const electronProcess = process as ElectronProcess;
  if (electronProcess.versions.electron == null) return undefined;
  if (electronProcess.defaultApp === true) return undefined;
  return electronProcess.resourcesPath;
}

// ---------------------------------------------------------------------------
// SDK export resolution
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the main export of a dynamically-imported SDK module.
 *
 * esbuild's CJS output for an ESM-only package can surface the named export
 * directly (`mod.exportName`), under `default` (`mod.default.exportName`), or
 * as `mod.default` itself; this checks all three and asserts the result is
 * callable. The caller keeps its own `await import('<literal>')` (see the file
 * header) and passes the resulting module here.
 *
 * @throws if the export is missing or not a function — a build-configuration
 * error (the package landed in esbuild's `external` array).
 */
export function resolveSdkExport<T>(
  mod: Record<string, unknown>,
  opts: {
    /** Property name of the export inside the module (e.g. `query`, `Codex`). */
    readonly exportName: string;
    /** Package specifier, for the error message (e.g. `@openai/codex-sdk`). */
    readonly specifier: string;
    /** Human label for the export in the error (e.g. `query()`, `Codex class`). */
    readonly errorLabel: string;
  },
): T {
  const value =
    mod[opts.exportName] ??
    (mod.default as Record<string, unknown> | undefined)?.[opts.exportName] ??
    mod.default;

  if (typeof value !== 'function') {
    const keys = Object.keys(mod).join(', ');
    throw new Error(
      `${opts.errorLabel} not found in ${opts.specifier}. Module keys: [${keys}]. ` +
        `Ensure ${opts.specifier} is NOT in esbuild externals.`,
    );
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// 4-stage binary resolution
//
// The Claude Code and Codex tools both locate a native CLI binary shipped as
// npm platform packages via the same 4-stage probe: packaged Electron
// resources → local node_modules → global npm prefix → PATH. They differ only
// in package names, where the binary sits inside a resolved package, and the
// PATH command name. `resolveBinary(config)` captures the shared skeleton and
// defers those specifics to the config.
// ---------------------------------------------------------------------------

export interface ResolveBinaryConfig {
  /**
   * npm platform package names to probe for the current platform/arch (e.g.
   * `['@anthropic-ai/claude-agent-sdk-linux-x64']`). Empty/undefined means the
   * platform is unsupported and resolution returns `undefined`.
   */
  readonly platformPackages: readonly string[];
  /**
   * Locate the binary inside a resolved platform-package directory, returning
   * its path if present or `undefined`. Codex nests the binary under
   * `vendor/<triple>/codex/`; Claude places it directly in the package dir.
   */
  binaryInPlatformPackage(platformPkgDir: string): Promise<string | undefined>;
  /**
   * Global npm-prefix package roots to resolve the platform package from,
   * given the detected `npm prefix -g`. Each root is passed to Node module
   * resolution; the first that resolves a platform package + binary wins.
   */
  globalPrefixRoots(prefix: string): readonly string[];
  /** Command name for the PATH lookup (e.g. `claude`, `codex`). */
  readonly pathCommand: string;
}

/**
 * Resolve a native CLI binary via the shared 4-stage probe. Returns the
 * resolved path, or `undefined` to let the caller fall back to its own
 * resolution. Caching is handled by {@link createCachedBinaryResolver}.
 */
async function resolveBinary(
  config: ResolveBinaryConfig,
): Promise<string | undefined> {
  if (config.platformPackages.length === 0) return undefined;

  // Strategy 1: packaged Electron app.asar.unpacked resources
  // Highest priority when present — packaged apps cannot execute binaries
  // from inside app.asar.
  {
    const resourcesPath = getPackagedElectronResourcesPath();
    if (resourcesPath != null) {
      for (const pkg of config.platformPackages) {
        const platformPkgDir = path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          ...pkg.split('/'),
        );
        const binary = await config.binaryInPlatformPackage(platformPkgDir);
        if (binary) return binary;
      }
    }
  }

  // Strategy 2: resolve from local project's node_modules
  // Preferred in VS Code extension development — matches package.json.
  {
    const result = await resolveBinaryFromBase(
      path.join(__dirname, '..'),
      config,
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
      for (const root of config.globalPrefixRoots(prefix)) {
        const result = await resolveBinaryFromBase(root, config);
        if (result) return result;
      }
    }
  }

  // Strategy 4: PATH lookup (native installer, Homebrew, manual install)
  // Fallback — may find an older version that doesn't match the SDK.
  {
    const lookupResult = executeCommandSync(
      [IS_WINDOWS ? 'where' : 'which', config.pathCommand],
      {
        timeout: 5000,
      },
    );
    const pathHits = lookupResult.success
      ? lookupResult.stdout.split(/\r?\n/)
      : [];

    for (const hit of pathHits) {
      const p = hit.trim();
      if (!p) continue;
      // The SDK spawns the binary directly, so only a real executable is
      // usable. `npm install -g` writes three shims next to each other —
      // `claude`, `claude.cmd` and `claude.ps1` — and none of them can be
      // spawned on Windows: the first is a POSIX sh script for Git Bash, and
      // the other two need a shell. Requiring .exe rejects all three, so the
      // tool reports "not found" with its install guide instead of resolving
      // to a path that fails at spawn time.
      if (IS_WINDOWS && !/\.exe$/i.test(p)) continue;
      if (await AbsoluteFS.exists(p)) return p;
    }
  }

  return undefined;
}

/**
 * Wrap a per-session cache around {@link resolveBinary}. The returned function
 * caches a resolved path for the process lifetime but always retries misses
 * (so a mid-session `npm install -g` is picked up).
 *
 * `buildConfig` returns the {@link ResolveBinaryConfig} for the current
 * platform, or `undefined` when the platform is unsupported — in which case the
 * resolver short-circuits to `undefined` without probing.
 */
export function createCachedBinaryResolver(
  buildConfig: () => ResolveBinaryConfig | undefined,
): () => Promise<string | undefined> {
  let cached: string | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const config = buildConfig();
    if (!config) return undefined;
    const result = await resolveBinary(config);
    if (result) cached = result;
    return result;
  };
}

/**
 * Resolve the platform package from `baseDir` via Node module resolution, then
 * locate the binary inside it. Returns the binary path if found.
 */
async function resolveBinaryFromBase(
  baseDir: string,
  config: ResolveBinaryConfig,
): Promise<string | undefined> {
  const req = createRequire(path.join(baseDir, 'package.json'));
  for (const pkg of config.platformPackages) {
    try {
      const platformPkgJson = req.resolve(`${pkg}/package.json`);
      const binary = await config.binaryInPlatformPackage(
        path.dirname(platformPkgJson),
      );
      if (binary) return binary;
    } catch {
      // Platform package not resolvable
    }
  }
  return undefined;
}
