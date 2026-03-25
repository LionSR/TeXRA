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
 *    130 MB platform binaries in the VSIX, we probe local node_modules,
 *    the global npm prefix, and PATH (in that priority order), then return
 *    the path for `codexPathOverride`. Results are cached for the session.
 */

import { execSync } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import { existsSync } from 'fs';

import { isWSL, windowsToWslPath } from '@utils/system/wslDetect';

type CodexConstructor = new (options?: any) => any;

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
    const code = (err as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
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
const PLATFORM_INFO: Record<string, { pkg: string; triple: string }> = {
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
export function findCodexBinaryPath(): string | undefined {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath;

  const result = findCodexBinaryPathUncached();
  if (result) cachedBinaryPath = result;
  return result;
}

function findCodexBinaryPathUncached(): string | undefined {
  const info = PLATFORM_INFO[`${process.platform}-${process.arch}`];
  if (!info) return undefined;

  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';

  // Strategy 1: resolve from local project's node_modules
  // Highest priority — matches the SDK version in package.json.
  try {
    const localReq = createRequire(path.join(__dirname, 'package.json'));
    const pkgJson = localReq.resolve(`${info.pkg}/package.json`);
    const vendorRoot = path.join(path.dirname(pkgJson), 'vendor');
    const binary = path.join(vendorRoot, info.triple, 'codex', binaryName);
    if (existsSync(binary)) return binary;
  } catch {
    // Not available locally
  }

  // Strategy 2: resolve from global npm prefix
  // Preferred over PATH because the npm-installed binary matches the SDK.
  try {
    const prefix = execSync('npm prefix -g', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    const roots = [
      path.join(prefix, 'lib', 'node_modules'),
      path.join(prefix, 'node_modules'),
    ];

    for (const root of roots) {
      const codexPkgDir = path.join(root, '@openai', 'codex');
      if (!existsSync(codexPkgDir)) continue;

      try {
        const req = createRequire(path.join(codexPkgDir, 'package.json'));
        const platformPkgJson = req.resolve(`${info.pkg}/package.json`);
        const vendorRoot = path.join(path.dirname(platformPkgJson), 'vendor');
        const binary = path.join(vendorRoot, info.triple, 'codex', binaryName);
        if (existsSync(binary)) return binary;
      } catch {
        // Platform package not resolvable from this root
      }
    }
  } catch {
    // npm prefix -g failed
  }

  // Strategy 3: PATH lookup (Homebrew, manual install, etc.)
  // Fallback — may find an older version that doesn't match the SDK.
  try {
    const whichCmd =
      process.platform === 'win32' ? 'where codex' : 'which codex';
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
    // codex not on PATH
  }

  // Strategy 4 (WSL only): try Windows-side installation.
  // Windows .exe files are executable under WSL via interop, so a
  // Codex binary installed on the Windows side works transparently.
  if (isWSL()) {
    const winResult = findCodexInWindowsSide();
    if (winResult) return winResult;
  }

  return undefined;
}

/**
 * WSL-only: attempt to locate the Codex binary from a Windows-side npm
 * installation.  Windows executables are runnable under WSL via binfmt_misc
 * interop, so we can return a `.exe` path directly.
 */
function findCodexInWindowsSide(): string | undefined {
  const winInfo = PLATFORM_INFO[`win32-${process.arch}`];
  if (!winInfo) return undefined;

  // Strategy 4a: resolve from the Windows npm global prefix via cmd.exe
  try {
    const rawPrefix = execSync('cmd.exe /c npm prefix -g', {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (rawPrefix) {
      const wslPrefix = windowsToWslPath(rawPrefix);
      if (wslPrefix) {
        // Windows npm stores globals in <prefix>/node_modules
        const root = path.join(wslPrefix, 'node_modules');
        const codexPkgDir = path.join(root, '@openai', 'codex');
        if (existsSync(codexPkgDir)) {
          try {
            const req = createRequire(
              path.join(codexPkgDir, 'package.json'),
            );
            const platformPkgJson = req.resolve(
              `${winInfo.pkg}/package.json`,
            );
            const vendorRoot = path.join(
              path.dirname(platformPkgJson),
              'vendor',
            );
            const binary = path.join(
              vendorRoot,
              winInfo.triple,
              'codex',
              'codex.exe',
            );
            if (existsSync(binary)) return binary;
          } catch {
            // Platform package not resolvable from this root
          }
        }
      }
    }
  } catch {
    // cmd.exe or npm not available (WSL interop may be disabled)
  }

  // Strategy 4b: codex.exe on PATH (Windows PATH exposed via WSL interop)
  try {
    const pathHits = execSync('which codex.exe', {
      encoding: 'utf8',
      timeout: 5000,
    })
      .trim()
      .split(/\r?\n/);

    for (const hit of pathHits) {
      const p = hit.trim();
      if (!p) continue;
      if (existsSync(p)) return p;
    }
  } catch {
    // codex.exe not on PATH
  }

  return undefined;
}
