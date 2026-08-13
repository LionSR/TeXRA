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
 */

import * as path from 'node:path';

import { isModuleNotFoundError } from '@common/errors';
import { AbsoluteFS } from '@utils/files/absoluteFS';
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

let cachedQuery: QueryFn | undefined;

/**
 * Import the `query` function from `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK is ESM-only ("type": "module"). esbuild converts the dynamic import
 * to a CJS require at build time — keep the package OUT of esbuild's
 * `external` array.
 */
export async function importClaudeAgentSdk(): Promise<QueryFn> {
  if (cachedQuery) return cachedQuery;

  let mod: Record<string, unknown>;
  try {
    mod = await import('@anthropic-ai/claude-agent-sdk');
  } catch (err: unknown) {
    if (isModuleNotFoundError(err)) {
      throw new Error(
        '@anthropic-ai/claude-agent-sdk package not found. Reinstall TeXRA or run corepack pnpm install in the TeXRA workspace.',
      );
    }
    throw err;
  }

  cachedQuery = resolveSdkExport<QueryFn>(mod, {
    exportName: 'query',
    specifier: '@anthropic-ai/claude-agent-sdk',
    errorLabel: 'query()',
  });
  return cachedQuery;
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

/** The platform binary sits directly in the platform-package directory. */
async function claudeBinaryInPlatformPackage(
  platformPkgDir: string,
): Promise<string | undefined> {
  const binary = path.join(platformPkgDir, CLAUDE_BINARY_NAME);
  return (await AbsoluteFS.exists(binary)) ? binary : undefined;
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
