/**
 * WSL (Windows Subsystem for Linux) detection.
 *
 * Delegates to the maintained `is-wsl` package rather than hand-parsing
 * `/proc/version`: it also checks `os.release()`, the WSL-specific
 * `/proc/sys/fs/binfmt_misc/WSLInterop` and `/run/WSL` markers, and excludes
 * containers running on a WSL host (via `is-inside-container`) so a devcontainer
 * isn't misreported as WSL. `is-wsl` computes its result once at import, so the
 * previous module-level cache is no longer needed.
 *
 * This module is intentionally free of VS Code dependencies so it can be
 * imported from VS Code-free zones like `src/tools/`.
 */

import isWsl from 'is-wsl';

/**
 * Whether we are running inside Windows Subsystem for Linux (WSL).
 * Kept as a function so existing call sites (`isWSL()`) stay unchanged.
 */
export function isWSL(): boolean {
  return isWsl;
}
