/**
 * Helpers for the Claude Code CLI tool.
 *
 * 1. `importClaudeAgentSdk()` — import `query` from `@anthropic-ai/claude-agent-sdk`.
 *    The SDK is ESM-only; esbuild converts it to CJS at bundle time (so it must
 *    NOT be listed in esbuild's `external` array). The dynamic import() below
 *    is rewritten to require() by esbuild.
 *
 * 2. `findClaudeBinaryPath()` — locate the native Claude Code CLI binary. The
 *    SDK bundles its own platform binary as an optional dependency, but in a
 *    packaged Electron/VSIX build it cannot resolve that binary via Node's
 *    package resolution. We probe Electron's `app.asar.unpacked` resources,
 *    the local `node_modules`, the global npm prefix, and PATH (in that
 *    priority order) and pass the result as `pathToClaudeCodeExecutable` to
 *    `query()`. Results are cached for the session.
 *
 * 3. `getClaudeAgentConfig()` — the same lazy access for `claudeAgentConfig`,
 *    which the tool-registration path must not pull in eagerly, plus the one
 *    reading of the call's effective permission mode.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { Effect } from 'effect';

import { isModuleNotFoundError } from '@common/errors';
import type { StateStore } from '@platform/interfaces';
import type { ClaudeAgentPermissionMode } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { IS_WINDOWS } from '@utils/system/platformPaths';
import {
  createCachedBinaryResolver,
  resolveSdkExport,
} from './support/externalBinaryUtils';
// Mirror the native `query` signature exactly (no hand-rolled structural copy).
type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query;

// ---------------------------------------------------------------------------
// SDK import
// ---------------------------------------------------------------------------

/**
 * Import the `query` function from `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK is ESM-only ("type": "module"). esbuild converts the dynamic import
 * to a CJS require at build time — keep the package OUT of esbuild's
 * `external` array. The dynamic import is this module's one foreign edge and
 * is wrapped exactly once, here; a missing package is re-stated as install
 * guidance with the original attached as `cause`, so callers classify it off
 * the cause chain rather than the message text.
 *
 * No memo of its own: `import()` resolves an already-loaded module from Node's
 * module cache, so a repeat call is a cache hit — the same shape
 * `importCodexClass` has.
 */
export function importClaudeAgentSdk(): Effect.Effect<QueryFn, Error> {
  return Effect.tryPromise({
    try: (): Promise<Record<string, unknown>> =>
      import('@anthropic-ai/claude-agent-sdk'),
    catch: (err) =>
      isModuleNotFoundError(err)
        ? new Error(
            '@anthropic-ai/claude-agent-sdk package not found. Reinstall TeXRA or run corepack pnpm install in the TeXRA workspace.',
            { cause: err },
          )
        : ensureError(err),
  }).pipe(
    Effect.flatMap((mod) =>
      Effect.try({
        try: () =>
          resolveSdkExport<QueryFn>(mod, {
            exportName: 'query',
            specifier: '@anthropic-ai/claude-agent-sdk',
            errorLabel: 'query()',
          }),
        catch: ensureError,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Platform key → npm package names for the bundled `claude` binary.
 * Linux has separate glibc and musl packages; trying both keeps the resolver
 * independent of libc detection.
 */
const PLATFORM_PACKAGES: Record<string, readonly string[]> = {
  'linux-x64': [
    '@anthropic-ai/claude-agent-sdk-linux-x64',
    '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  ],
  'linux-arm64': [
    '@anthropic-ai/claude-agent-sdk-linux-arm64',
    '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  ],
  'darwin-x64': ['@anthropic-ai/claude-agent-sdk-darwin-x64'],
  'darwin-arm64': ['@anthropic-ai/claude-agent-sdk-darwin-arm64'],
  'win32-x64': ['@anthropic-ai/claude-agent-sdk-win32-x64'],
  'win32-arm64': ['@anthropic-ai/claude-agent-sdk-win32-arm64'],
};

/** Native CLI binary filename for the current platform. */
const CLAUDE_BINARY_NAME = IS_WINDOWS ? 'claude.exe' : 'claude';

/**
 * The platform binary sits directly in the platform-package directory.
 *
 * The probe is a plain predicate on a path this module just built, over the
 * real filesystem the packaged binary lives on, so it stays synchronous like
 * the sibling `which.sync` / `executeCommandSync` probes. The static it
 * replaces asked lstat, which counted a dangling symlink as present where
 * `existsSync`'s access probe does not — a link no executable can be run
 * through either way.
 */
function claudeBinaryInPlatformPackage(
  platformPkgDir: string,
): string | undefined {
  const binary = path.join(platformPkgDir, CLAUDE_BINARY_NAME);
  return existsSync(binary) ? binary : undefined;
}

/**
 * Locate the native Claude Code CLI binary. Results are cached for the session
 * (misses are always retried so mid-session installs are picked up).
 *
 * The caller should pass the result as `pathToClaudeCodeExecutable` to the
 * SDK's `query()` options. Returning `undefined` lets the SDK fall back to
 * its own resolution.
 */
export const findClaudeBinaryPath = createCachedBinaryResolver(() => {
  const platformPackages =
    PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!platformPackages) return undefined;

  return {
    platformPackages,
    binaryInPlatformPackage: claudeBinaryInPlatformPackage,
    // The npm global prefix hosts the `@anthropic-ai/claude-agent-sdk`
    // package; the platform packages resolve relative to those roots.
    globalPrefixRoots: (prefix) => [
      path.join(
        prefix,
        'lib',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk',
      ),
      path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
    ],
    pathCommand: 'claude',
  };
});

/** Lazy accessor for claudeAgentConfig.ts exports (loaded once, cached). */
let configModule: typeof import('./claudeAgentConfig.js') | null = null;
export const getClaudeAgentConfig = Effect.promise(
  async () => (configModule ??= await import('./claudeAgentConfig.js')),
);

/**
 * The permission mode a claude_code call runs under: its own override, else
 * the workspace default. The approval prompt the loop opens and the launch
 * that follows it read the same one from here.
 */
export const claudeAgentPermissionMode = (
  input: { readonly permission_mode?: ClaudeAgentPermissionMode | null },
  workspaceState: StateStore,
): Effect.Effect<ClaudeAgentPermissionMode> =>
  Effect.map(getClaudeAgentConfig, (config) =>
    input.permission_mode == null
      ? config.getClaudeAgentPermissionMode(workspaceState)
      : input.permission_mode,
  );
