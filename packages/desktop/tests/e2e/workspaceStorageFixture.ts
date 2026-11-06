import { cpSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Remove a temporary E2E directory without hiding the primary assertion. */
export function cleanupDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup must not hide the assertion that failed.
  }
}

/**
 * Allocate a fresh workspace + Electron user-data directory pair for a test
 * that relaunches the desktop app against a shared profile (relaunch-based
 * persistence and repair tests). Callers are responsible for cleaning up
 * both paths with `cleanupDirectory` once the app under test is closed.
 */
export function createIsolatedProfile(): {
  workspacePath: string;
  userDataPath: string;
} {
  return {
    workspacePath: mkdtempSync(join(tmpdir(), 'texra-e2e-workspace-')),
    userDataPath: mkdtempSync(join(tmpdir(), 'texra-e2e-user-data-')),
  };
}

/**
 * `use` over a copy of the project store at `storagePath` (its `texra.db`
 * and write-ahead log): the process that holds a project store admits no
 * other, so a test reads what it has committed from the files. The copy
 * is removed once `use` returns, or once the promise it returns settles.
 */
export function withStoreCopy<A>(
  storagePath: string,
  use: (copy: string) => A,
): A {
  const copy = mkdtempSync(join(tmpdir(), 'texra-e2e-store-copy-'));
  for (const name of ['texra.db', 'texra.db-wal']) {
    const file = join(storagePath, name);
    if (existsSync(file)) cpSync(file, join(copy, name));
  }
  const remove = () => rmSync(copy, { recursive: true, force: true });
  let result: A;
  try {
    result = use(copy);
  } catch (error) {
    remove();
    throw error;
  }
  // cast: a promise's settled copy is the same `A` the caller returned.
  if (result instanceof Promise) return result.finally(remove) as A;
  remove();
  return result;
}
