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

import { Effect } from 'effect';
import which from 'which';

import { isModuleNotFoundError } from '@common/errors';
import { withLogChannel } from '@logger/effectLog';
import { nodeHostEnvironment } from '@platform/defaults/nodeHostEnvironment';
import { ensureError } from '@utils/errors/errorMessage';
import { executeCommand } from '@utils/system/execUtils';
import { IS_WINDOWS, extendEnvPath } from '@utils/system/platformPaths';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const CHANNEL = 'ExternalBinaryUtils';

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
   * `vendor/<triple>/bin/` (older packages: `vendor/<triple>/codex/`) and may
   * follow a nested package through {@link resolvePackageDir}; Claude places
   * it directly in the package dir.
   */
  binaryInPlatformPackage(
    platformPkgDir: string,
  ): Effect.Effect<string | undefined>;
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
const resolveBinary = Effect.fn('externalBinaryUtils.resolveBinary')(function* (
  config: ResolveBinaryConfig,
): Effect.fn.Return<string | undefined, never, ChildProcessSpawner> {
  if (config.platformPackages.length === 0) return undefined;

  // Strategy 1: packaged Electron app.asar.unpacked resources
  // Highest priority when present — packaged apps cannot execute binaries
  // from inside app.asar.
  const resourcesPath = nodeHostEnvironment.packagedElectronResourcesPath();
  if (resourcesPath != null) {
    for (const pkg of config.platformPackages) {
      const platformPkgDir = path.join(
        resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        ...pkg.split('/'),
      );
      const binary = yield* config.binaryInPlatformPackage(platformPkgDir);
      if (binary) return binary;
    }
  }

  // Strategy 2: resolve from local project's node_modules
  // Preferred in VS Code extension development — matches package.json.
  const local = yield* resolveBinaryFromBase(
    path.join(__dirname, '..'),
    config,
  );
  if (local) return local;

  // Strategy 3: resolve from global npm prefix
  // Preferred over PATH because the npm-installed binary matches the SDK.
  //
  // `npm prefix -g` reports the global prefix, which does not depend on the
  // directory it is asked from: the process cwd, not a workspace root, and
  // no workspace settings either.
  const prefixResult = yield* executeCommand(['npm', 'prefix', '-g'], {
    cwd: process.cwd(),
    settings: undefined,
    timeout: 5000,
  });
  const prefix = prefixResult.success ? prefixResult.stdout : undefined;
  if (prefix) {
    for (const root of config.globalPrefixRoots(prefix)) {
      const result = yield* resolveBinaryFromBase(root, config);
      if (result) return result;
    }
  }

  // Strategy 4: PATH lookup (native installer, Homebrew, manual install)
  // Fallback — may find an older version that doesn't match the SDK.
  //
  // The SDK spawns the binary directly, so only a real executable is usable.
  // `npm install -g` writes three shims next to each other — `claude`,
  // `claude.cmd` and `claude.ps1` — and none of them can be spawned on
  // Windows: the first is a POSIX sh script for Git Bash, and the other two
  // need a shell. Restricting PATHEXT to `.EXE` rejects all three, so the
  // tool reports "not found" with its install guide instead of resolving to
  // a path that fails at spawn time.
  return (
    which.sync(config.pathCommand, {
      nothrow: true,
      path: extendEnvPath(),
      ...(IS_WINDOWS ? { pathExt: '.EXE' } : {}),
    }) ?? undefined
  );
});

/**
 * Wrap a per-session cache around {@link resolveBinary}. The returned program
 * caches a resolved path for the process lifetime but always retries misses
 * (so a mid-session `npm install -g` is picked up).
 *
 * `buildConfig` returns the {@link ResolveBinaryConfig} for the current
 * platform, or `undefined` when the platform is unsupported — in which case the
 * resolver short-circuits to `undefined` without probing.
 */
export function createCachedBinaryResolver(
  buildConfig: () => ResolveBinaryConfig | undefined,
): () => Effect.Effect<string | undefined, Error, ChildProcessSpawner> {
  let cached: string | undefined;
  return () =>
    Effect.suspend(() => {
      if (cached !== undefined) return Effect.succeed(cached);
      const config = buildConfig();
      if (!config) return Effect.succeed(undefined);
      return resolveBinary(config).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result) cached = result;
          }),
        ),
      );
    }).pipe(
      // The probe steps are plain synchronous calls (Node module resolution,
      // `existsSync`, the PATH extension, `which.sync`); one that throws is a
      // failed lookup the caller reports, not a crash of the calling fiber.
      Effect.catchDefect((defect) => Effect.fail(ensureError(defect))),
    );
}

/**
 * Directory of `pkg` as Node module resolution finds it from `baseDir`, or
 * `undefined` when the package is not installed there.
 *
 * Node reports "not installed" by throwing `MODULE_NOT_FOUND`, and that throw
 * is the answer, not a failure — every probe stage asks about packages that
 * are legitimately absent. Anything else (an unreadable or malformed
 * `package.json`, a permission error) is a real failure the probe would
 * otherwise report as a plain "not found", so it is logged before the probe
 * moves on.
 */
export function resolvePackageDir(
  baseDir: string,
  pkg: string,
): Effect.Effect<string | undefined> {
  return Effect.try({
    try: (): string | undefined => {
      const req = createRequire(path.join(baseDir, 'package.json'));
      return path.dirname(req.resolve(`${pkg}/package.json`));
    },
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      isModuleNotFoundError(error)
        ? Effect.succeed(undefined)
        : Effect.logWarning(`Could not resolve ${pkg} from ${baseDir}`).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
            Effect.as(undefined),
          ),
    ),
  );
}

/**
 * Resolve the platform package from `baseDir` via Node module resolution, then
 * locate the binary inside it. Returns the binary path if found.
 */
const resolveBinaryFromBase = Effect.fn(
  'externalBinaryUtils.resolveBinaryFromBase',
)(function* (
  baseDir: string,
  config: ResolveBinaryConfig,
): Effect.fn.Return<string | undefined> {
  for (const pkg of config.platformPackages) {
    const platformPkgDir = yield* resolvePackageDir(baseDir, pkg);
    if (platformPkgDir === undefined) continue;
    const binary = yield* config.binaryInPlatformPackage(platformPkgDir);
    if (binary) return binary;
  }
  return undefined;
});
