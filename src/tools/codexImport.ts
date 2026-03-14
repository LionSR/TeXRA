/**
 * Helpers for the Codex tool.
 *
 * 1. `importCodexClass()` — dynamically import the Codex constructor from
 *    @openai/codex-sdk. Handles ESM/CJS interop edge cases.
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
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';

type CodexConstructor = new (options?: any) => any;

// ---------------------------------------------------------------------------
// SDK import
// ---------------------------------------------------------------------------

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

  const resolved = resolveCodexConstructor(mod);
  if (resolved) return resolved;

  // When the extension host runs in CJS mode (Electron), dynamic import() of
  // an ESM-only package may lose named exports (only an empty `default` object
  // appears). Locate the package on disk, read its ESM entry point from
  // package.json, and re-import via file:// URL so Node loads it as true ESM.
  try {
    const entryFile = resolveEsmEntryPoint('@openai/codex-sdk');
    if (entryFile) {
      const fileUrl = pathToFileURL(entryFile).href;
      const esmMod = (await import(fileUrl)) as Record<string, unknown>;
      const esmResolved = resolveCodexConstructor(esmMod);
      if (esmResolved) return esmResolved;
    }
  } catch {
    // Fall through to error below
  }

  // Build a diagnostic message showing what we actually got
  const defType = typeof mod.default;
  const defKeys =
    mod.default && typeof mod.default === 'object'
      ? Object.keys(mod.default as Record<string, unknown>).join(', ')
      : defType;
  throw new Error(
    'Failed to resolve Codex class from @openai/codex-sdk. ' +
      `Module keys: [${Object.keys(mod).join(', ')}], ` +
      `default type: ${defType}, default keys: [${defKeys}]`,
  );
}

/**
 * Probe all possible export shapes for the Codex constructor.
 * Electron's ESM/CJS interop may wrap named exports under `default`,
 * sometimes double-nested.
 */
function resolveCodexConstructor(
  mod: Record<string, unknown>,
): CodexConstructor | undefined {
  const candidates: unknown[] = [
    mod.Codex, // named export
    (mod.default as Record<string, unknown> | undefined)?.Codex, // default.Codex
    mod.default, // default IS the class
  ];

  // Double-nested: mod.default.default.Codex or mod.default.default
  const innerDefault = (mod.default as Record<string, unknown> | undefined)
    ?.default;
  if (innerDefault && typeof innerDefault === 'object') {
    candidates.push((innerDefault as Record<string, unknown>).Codex);
  }
  candidates.push(innerDefault);

  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      return candidate as CodexConstructor;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ESM entry-point resolution
// ---------------------------------------------------------------------------

/**
 * Walk node_modules directories upward from `__dirname` to find an ESM-only
 * package and return the absolute path to its ESM entry file.
 *
 * We can't use `require.resolve()` because the package exports map has no
 * `"require"` condition — only `"import"`.  Instead we locate the package
 * directory manually, read its `package.json`, and extract the entry from
 * `exports["."].import` (falling back to the `module` field).
 */
function resolveEsmEntryPoint(packageName: string): string | undefined {
  let dir = __dirname;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pkgJsonPath = path.join(
      dir,
      'node_modules',
      packageName,
      'package.json',
    );
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        // Prefer exports["."].import, then top-level "module"
        const relEntry =
          (typeof pkg.exports === 'object' &&
            pkg.exports['.'] &&
            (typeof pkg.exports['.'] === 'string'
              ? pkg.exports['.']
              : pkg.exports['.'].import)) ||
          pkg.module;
        if (typeof relEntry === 'string') {
          const abs = path.resolve(path.dirname(pkgJsonPath), relEntry);
          if (existsSync(abs)) return abs;
        }
      } catch {
        // Malformed package.json — skip
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
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

  return undefined;
}
