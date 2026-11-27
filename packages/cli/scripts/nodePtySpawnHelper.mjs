import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

/**
 * Restore the execute bit on node-pty's prebuilt `spawn-helper` when the
 * install dropped it, which a script does before it loads node-pty.
 */
export function ensureNodePtySpawnHelperExecutable() {
  if (process.platform === 'win32') return;

  try {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
    const helperPath = path.join(
      packageRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );
    if (!existsSync(helperPath)) return;

    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) === 0) chmodSync(helperPath, mode | 0o755);
  } catch {
    // node-pty will report the underlying PTY load/spawn failure itself.
  }
}

/** node-pty's `spawn`, with its helper made executable first. */
export async function loadPtySpawn() {
  ensureNodePtySpawnHelperExecutable();
  const pty = await import('node-pty');
  const spawn = pty.spawn ?? pty.default?.spawn;
  if (typeof spawn !== 'function')
    throw new Error('node-pty did not expose spawn');
  return spawn;
}
