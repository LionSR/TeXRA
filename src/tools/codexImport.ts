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
 *
 * 3. `getCodexConfig()` — the same lazy access for `codexConfig`, which the
 *    tool-registration path must not pull in eagerly, plus the one reading of
 *    the call's effective sandbox mode.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { Effect } from 'effect';

import type { StateReadFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { CodexSandboxMode } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingUnlessOverridden } from '@utils/config/platformSettings';
import { IS_WINDOWS } from '@utils/system/platformPaths';

import {
  createCachedBinaryResolver,
  importForeignSdk,
  resolvePackageDir,
} from './support/externalBinaryUtils';

// The native `Codex` class value; `typeof` gives its construct signature
// (`new (options?: CodexOptions) => Codex`) so construction stays type-checked.
type CodexConstructor = typeof import('@openai/codex-sdk').Codex;
type SandboxMode = import('@openai/codex-sdk').SandboxMode;
type PlatformInfo = { pkg: string; triple: string };

/**
 * Every `CodexSandboxMode` catalog value must be one the SDK's `SandboxMode`
 * union accepts, so a persisted value the SDK doesn't support fails to
 * compile here. `codexSandboxMode` below reads through the shared
 * override-or-setting helper typed to the SDK's own `SandboxMode`, not this
 * narrower catalog type, so this stand-alone assert is what used to live in
 * that read's declared return type (mirrors `_EffortLevelsAligned` in
 * `claudeAgentShared.ts`).
 */
type _AssertExtends<T extends true> = T;
type _CodexSandboxModeAligned = _AssertExtends<
  CodexSandboxMode extends SandboxMode ? true : false
>;

// ---------------------------------------------------------------------------
// SDK import
// ---------------------------------------------------------------------------

/**
 * Import the Codex class from @openai/codex-sdk.
 *
 * The SDK is ESM-only, but esbuild converts it to CJS at build time (it must
 * NOT be listed in esbuild's `external` array). The dynamic import() here is
 * converted to require() by esbuild, so it works in VS Code's extension host.
 * That import is this module's one foreign edge, kept inline as a literal for
 * esbuild's benefit; {@link importForeignSdk} wraps everything downstream of
 * it (the shape shared with `importClaudeAgentSdk`).
 */
export function importCodexClass(): Effect.Effect<CodexConstructor, Error> {
  return importForeignSdk<CodexConstructor>({
    load: (): Promise<Record<string, unknown>> => import('@openai/codex-sdk'),
    notFoundMessage:
      '@openai/codex-sdk package not found. Install with: npm install -g @openai/codex',
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
const codexBinaryInPlatformPackage = Effect.fn(
  'codexImport.codexBinaryInPlatformPackage',
)(function* (
  platformPkgDir: string,
  platformInfo: PlatformInfo,
): Effect.fn.Return<string | undefined> {
  const findInPlatformPackage = (packageDir: string): string | undefined => {
    const vendorDir = path.join(packageDir, 'vendor', platformInfo.triple);
    const candidates = [
      path.join(vendorDir, 'bin', CODEX_BINARY_NAME),
      path.join(vendorDir, 'codex', CODEX_BINARY_NAME),
    ];
    // A plain predicate on a path this module just built, over the real
    // filesystem the packaged binary lives on. The static it replaces asked
    // lstat, which counted a dangling symlink as present where `existsSync`'s
    // access probe does not.
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  };

  const direct = findInPlatformPackage(platformPkgDir);
  if (direct) return direct;

  const nested = yield* resolvePackageDir(platformPkgDir, platformInfo.pkg);
  return nested === undefined ? undefined : findInPlatformPackage(nested);
});

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

/** Lazy accessor for codexConfig.ts exports (loaded once, cached). */
let configModule: typeof import('./codexConfig.js') | null = null;
export const getCodexConfig = Effect.promise(
  async () => (configModule ??= await import('./codexConfig.js')),
);

/**
 * The sandbox mode a codex call runs under: its own override, else the
 * user-configured default. The approval prompt the loop opens and the launch
 * that follows it read the same one from here. The schema↔SDK alignment
 * guard lives in {@link _CodexSandboxModeAligned} above, not in this read.
 */
export const codexSandboxMode = (
  input: { readonly sandbox_mode?: SandboxMode | null },
  stores: SettingsStores,
): Effect.Effect<SandboxMode, StateReadFailed> =>
  readSettingUnlessOverridden(
    input.sandbox_mode,
    stores,
    WorkspaceStateKey.CODEX_SANDBOX_MODE,
  );
