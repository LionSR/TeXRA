/**
 * WSL (Windows Subsystem for Linux) detection.
 *
 * This module is intentionally free of VS Code dependencies so it can be
 * imported from VS Code-free zones like `src/tools/`.
 */

import { readFileSync } from 'fs';

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
