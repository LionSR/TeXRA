/**
 * Helpers for the Claude Agent tool.
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

import { execSync } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import { existsSync } from 'fs';

type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}) => AsyncGenerator<unknown, void>;

type PlatformInfo = { pkg: string };
type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

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
    const code = (err as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(
        '@anthropic-ai/claude-agent-sdk package not found. Install with: npm install -g @anthropic-ai/claude-code',
      );
    }
    throw err;
  }

  const queryFn =
    mod.query ??
    (mod.default as Record<string, unknown> | undefined)?.query ??
    mod.default;

  if (typeof queryFn !== 'function') {
    const keys = Object.keys(mod).join(', ');
    throw new Error(
      `query() not found in @anthropic-ai/claude-agent-sdk. Module keys: [${keys}]. ` +
        'Ensure @anthropic-ai/claude-agent-sdk is NOT in esbuild externals.',
    );
  }

  cachedQuery = queryFn as QueryFn;
  return cachedQuery;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Platform key → npm package name for the bundled `claude` binary.
 * The Claude Agent SDK ships one platform package per OS/arch; each contains
 * a single `claude` binary at the package root.
 */
const PLATFORM_INFO: Record<string, PlatformInfo> = {
  'linux-x64': { pkg: '@anthropic-ai/claude-agent-sdk-linux-x64' },
  'linux-arm64': { pkg: '@anthropic-ai/claude-agent-sdk-linux-arm64' },
  'darwin-x64': { pkg: '@anthropic-ai/claude-agent-sdk-darwin-x64' },
  'darwin-arm64': { pkg: '@anthropic-ai/claude-agent-sdk-darwin-arm64' },
  'win32-x64': { pkg: '@anthropic-ai/claude-agent-sdk-win32-x64' },
  'win32-arm64': { pkg: '@anthropic-ai/claude-agent-sdk-win32-arm64' },
};

/** Cached result — found paths are cached; misses are retried. */
let cachedBinaryPath: string | undefined;

/**
 * Locate the native Claude Code CLI binary. Results are cached for the session
 * (misses are always retried so mid-session installs are picked up).
 *
 * The caller should pass the result as `pathToClaudeCodeExecutable` to the
 * SDK's `query()` options. Returning `undefined` lets the SDK fall back to
 * its own resolution.
 */
export function findClaudeBinaryPath(): string | undefined {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath;

  const result = findClaudeBinaryPathUncached();
  if (result) cachedBinaryPath = result;
  return result;
}

function findClaudeBinaryPathUncached(): string | undefined {
  const info = PLATFORM_INFO[`${process.platform}-${process.arch}`];
  if (!info) return undefined;

  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';

  // Strategy 1: packaged Electron app.asar.unpacked resources
  // Highest priority when present — packaged apps cannot execute binaries
  // from inside app.asar.
  {
    const resourcesPath = getPackagedElectronResourcesPath();
    const result =
      resourcesPath == null
        ? undefined
        : findClaudeBinaryInElectronResources(resourcesPath);
    if (result) return result;
  }

  // Strategy 2: resolve from local project's node_modules
  // Preferred in VS Code extension development — matches package.json.
  {
    const result = resolveClaudeBinary(path.join(__dirname, '..'), info);
    if (result) return result;
  }

  // Strategy 3: resolve from global npm prefix
  // Preferred over PATH because the npm-installed binary matches the SDK.
  try {
    const prefix = execSync('npm prefix -g', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    const roots = [
      path.join(
        prefix,
        'lib',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk',
      ),
      path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
    ];

    for (const sdkRoot of roots) {
      const result = resolveClaudeBinary(sdkRoot, info);
      if (result) return result;
    }
  } catch {
    // npm prefix -g failed
  }

  // Strategy 4: PATH lookup (native installer, Homebrew, manual install)
  // The Claude Code CLI's recommended installer drops a `claude` binary into
  // ~/.local/bin (or similar) that the SDK is happy to invoke directly.
  try {
    const whichCmd =
      process.platform === 'win32' ? 'where claude' : 'which claude';
    const pathHits = execSync(whichCmd, {
      encoding: 'utf8',
      timeout: 5000,
    })
      .trim()
      .split(/\r?\n/);

    // On Windows, skip .cmd/.ps1 shims (npm wrappers) — the SDK spawns
    // the binary directly without shell:true, so shims aren't executable.
    for (const hit of pathHits) {
      const p = hit.trim();
      if (!p) continue;
      if (process.platform === 'win32' && /\.(cmd|ps1)$/i.test(p)) continue;
      if (existsSync(p)) return p;
    }
  } catch {
    // claude not on PATH
  }

  return undefined;
}

/**
 * Locate the Claude binary inside an Electron packaged app's unpacked
 * resources directory.
 */
export function findClaudeBinaryInElectronResources(
  resourcesPath: string,
): string | undefined {
  const info = PLATFORM_INFO[`${process.platform}-${process.arch}`];
  if (!info) return undefined;

  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const platformPkgDir = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    ...info.pkg.split('/'),
  );

  const binary = path.join(platformPkgDir, binaryName);
  return existsSync(binary) ? binary : undefined;
}

function getPackagedElectronResourcesPath(): string | undefined {
  const electronProcess = process as ElectronProcess;
  if (electronProcess.versions.electron == null) return undefined;
  if (electronProcess.defaultApp === true) return undefined;
  return electronProcess.resourcesPath;
}

/**
 * Resolve the native Claude binary from a directory that contains (or nests)
 * the platform-specific package. Returns the binary path if found, or
 * `undefined`.
 */
function resolveClaudeBinary(
  baseDir: string,
  platformInfo: PlatformInfo,
): string | undefined {
  try {
    const req = createRequire(path.join(baseDir, 'package.json'));
    const platformPkgJson = req.resolve(`${platformInfo.pkg}/package.json`);
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const binary = path.join(path.dirname(platformPkgJson), binaryName);
    if (existsSync(binary)) return binary;
  } catch {
    // Platform package not resolvable
  }
  return undefined;
}
