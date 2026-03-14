/**
 * Helpers for the Codex tool.
 *
 * 1. `importCodexClass()` — dynamically import the Codex constructor from
 *    @openai/codex-sdk. Handles ESM/CJS interop edge cases.
 *
 * 2. `findCodexBinaryPath()` — locate the native Codex CLI binary from a
 *    global npm install. The SDK bundles its own `findCodexPath()` but it
 *    resolves `@openai/codex` relative to the SDK itself (inside the VSIX).
 *    Since we don't ship the 130 MB platform binaries in the VSIX, we probe
 *    the global npm prefix instead and return the path for `codexPathOverride`.
 */

import { execSync } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import { existsSync } from 'fs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  console.log(`[Codex] Module keys: [${Object.keys(mod).join(', ')}]`);

  // Normal named export
  if (typeof mod.Codex === 'function') {
    return mod.Codex as CodexConstructor;
  }

  // Wrapped under default (some ESM/CJS interop scenarios)
  const def = mod.default as Record<string, unknown> | undefined;
  if (def && typeof def.Codex === 'function') {
    return def.Codex as CodexConstructor;
  }
  if (typeof def === 'function') {
    return def as unknown as CodexConstructor;
  }

  throw new Error(
    `Failed to resolve Codex class from @openai/codex-sdk. Module keys: [${Object.keys(mod).join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Binary resolution from global npm install
// ---------------------------------------------------------------------------

const PLATFORM_PACKAGE: Record<string, string> = {
  'linux-x64': '@openai/codex-linux-x64',
  'linux-arm64': '@openai/codex-linux-arm64',
  'darwin-x64': '@openai/codex-darwin-x64',
  'darwin-arm64': '@openai/codex-darwin-arm64',
  'win32-x64': '@openai/codex-win32-x64',
  'win32-arm64': '@openai/codex-win32-arm64',
};

const TARGET_TRIPLE: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

/**
 * Attempt to locate the native Codex CLI binary from a global npm install.
 *
 * Returns the absolute path to the binary, or `undefined` if not found.
 * The caller should pass the result as `codexPathOverride` to the Codex
 * constructor.
 */
export function findCodexBinaryPath(): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  const platformPkg = PLATFORM_PACKAGE[key];
  const triple = TARGET_TRIPLE[key];
  if (!platformPkg || !triple) return undefined;

  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';

  // Strategy 1: resolve from global npm prefix
  try {
    const prefix = execSync('npm prefix -g', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    // Global packages live under <prefix>/lib/node_modules on Unix,
    // <prefix>/node_modules on Windows
    const roots = [
      path.join(prefix, 'lib', 'node_modules'),
      path.join(prefix, 'node_modules'),
    ];

    for (const root of roots) {
      const codexPkgDir = path.join(root, '@openai', 'codex');
      if (!existsSync(codexPkgDir)) continue;

      // Try resolving the platform binary package from the codex package
      try {
        const req = createRequire(path.join(codexPkgDir, 'package.json'));
        const platformPkgJson = req.resolve(`${platformPkg}/package.json`);
        const vendorRoot = path.join(
          path.dirname(platformPkgJson),
          'vendor',
        );
        const binary = path.join(vendorRoot, triple, 'codex', binaryName);
        if (existsSync(binary)) {
          console.log(`[Codex] Found binary via global npm: ${binary}`);
          return binary;
        }
      } catch {
        // Platform package not resolvable from this root, try next
      }

      // Also check if binaries are vendored directly in the codex package
      const localBinary = path.join(
        codexPkgDir,
        'vendor',
        triple,
        'codex',
        binaryName,
      );
      if (existsSync(localBinary)) {
        console.log(
          `[Codex] Found binary via global npm (local vendor): ${localBinary}`,
        );
        return localBinary;
      }
    }
  } catch {
    // npm prefix -g failed, try other strategies
  }

  // Strategy 2: resolve from the local project's node_modules
  // (for development environments where `npm install` was run)
  try {
    // Use the bundle's actual path — __filename in the built extension
    // points to dist/extension.js, which can resolve local node_modules
    const localReq = createRequire(path.join(__dirname, 'package.json'));
    const pkgJson = localReq.resolve(`${platformPkg}/package.json`);
    const vendorRoot = path.join(path.dirname(pkgJson), 'vendor');
    const binary = path.join(vendorRoot, triple, 'codex', binaryName);
    if (existsSync(binary)) {
      console.log(`[Codex] Found binary via local node_modules: ${binary}`);
      return binary;
    }
  } catch {
    // Not available locally
  }

  // Strategy 3: Homebrew / PATH-based install (e.g. `brew install codex`)
  // The `codex` on PATH may be the native binary directly (Homebrew) or a
  // Node.js wrapper script (npm). We accept it either way — the SDK's
  // CodexExec spawns it the same regardless.
  try {
    const whichCmd = process.platform === 'win32' ? 'where codex' : 'which codex';
    const codexOnPath = execSync(whichCmd, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim().split('\n')[0]; // `where` on Windows may return multiple

    if (codexOnPath && existsSync(codexOnPath)) {
      console.log(`[Codex] Found binary on PATH: ${codexOnPath}`);
      return codexOnPath;
    }
  } catch {
    // codex not on PATH
  }

  console.log('[Codex] Native binary not found');
  return undefined;
}
