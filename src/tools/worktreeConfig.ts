/**
 * Injectable worktree support flag.
 *
 * When disabled (default), delegate_agent ignores the working_directory
 * parameter and subagents operate in the workspace root only.
 *
 * The extension host calls {@link setWorktreeSupportEnabled} at activation
 * (and on settings change) with the value from workspace state. This module
 * stays VS Code-free.
 */

let worktreeSupport = false;

export function setWorktreeSupportEnabled(enabled: boolean): void {
  worktreeSupport = enabled;
}

export function isWorktreeSupportEnabled(): boolean {
  return worktreeSupport;
}
