/**
 * WSL (Windows Subsystem for Linux) detection.
 *
 * Delegates to the maintained `is-wsl` package rather than hand-parsing
 * `/proc/version`: it also checks `os.release()`, the WSL-specific
 * `/proc/sys/fs/binfmt_misc/WSLInterop` and `/run/WSL` markers, and excludes
 * containers running on a WSL host (via `is-inside-container`) so a devcontainer
 * isn't misreported as WSL.
 */

import isWsl from 'is-wsl';

/**
 * Whether this process runs inside Windows Subsystem for Linux (WSL), where
 * a tool installed on the Windows side is not on this side's PATH. `is-wsl`
 * computes the answer once, at import.
 */
export function runsInWsl(): boolean {
  return isWsl;
}
