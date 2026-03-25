/**
 * WSL (Windows Subsystem for Linux) detection utilities.
 *
 * This module is intentionally free of VS Code dependencies so it can be
 * imported from VS Code-free zones like `src/tools/`.
 */

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

/** Cached WSL detection result (null = not yet checked). */
let wslDetected: boolean | null = null;

/**
 * Detect whether we are running inside Windows Subsystem for Linux (WSL).
 * Checks /proc/version for the "microsoft" or "WSL" marker strings that
 * Microsoft's WSL kernel injects.  Result is cached after the first call.
 */
export function isWSL(): boolean {
  if (wslDetected !== null) return wslDetected;
  if (process.platform !== 'linux') {
    wslDetected = false;
    return false;
  }
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    wslDetected = /microsoft|wsl/i.test(version);
  } catch {
    wslDetected = false;
  }
  return wslDetected;
}

/**
 * Convert a Windows path to its WSL mount equivalent using `wslpath`.
 * Returns `undefined` if the conversion fails (e.g. `wslpath` not available
 * or WSL interop disabled).
 */
export function windowsToWslPath(windowsPath: string): string | undefined {
  try {
    const result = execFileSync('wslpath', ['-u', windowsPath], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}
