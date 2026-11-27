import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

/**
 * Restore the execute bit on node-pty's prebuilt `spawn-helper` when the
 * install dropped it.
 */
function ensureNodePtySpawnHelperExecutable() {
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

/** node-pty's `spawn`, for the validators that drive the CLI on a PTY. */
export async function loadPtySpawn() {
  ensureNodePtySpawnHelperExecutable();
  const ptyMod = await import('node-pty');
  const ptySpawn = ptyMod.spawn ?? ptyMod.default?.spawn;
  if (typeof ptySpawn !== 'function')
    throw new Error('node-pty did not expose spawn');
  return ptySpawn;
}
