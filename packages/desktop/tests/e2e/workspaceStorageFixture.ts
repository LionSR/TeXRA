import { rmSync, mkdtempSync } from 'node:fs';
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
