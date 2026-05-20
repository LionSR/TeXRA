/**
 * Shared constants and abstract command types for the Lean integration.
 *
 * Two adapters implement {@link LeanVscodeServices}: the VS Code path that
 * talks to the leanprover.lean4 extension, and the direct LSP path used by
 * the CLI and desktop builds. Both speak in terms of the abstract command
 * names declared here, so the underlying VS Code command IDs only live in
 * the VS Code adapter.
 */

/** Marketplace ID of the Lean 4 VS Code extension. */
export const LEAN4_EXTENSION_ID = 'leanprover.lean4';

/** Per-file commands surfaced by `lean_file`. */
export const LEAN_FILE_COMMANDS = ['restart', 'refresh_dependencies'] as const;
export type LeanFileCommand = (typeof LEAN_FILE_COMMANDS)[number];

/** Project-scope commands surfaced by `lean_project`. */
export const LEAN_PROJECT_COMMANDS = [
  // Server commands
  'restart_server',
  'stop_server',
  // Project commands
  'build',
  'clean',
  'fetch_cache',
  'fetch_file_cache',
  // Setup commands
  'install_elan',
  'install_deps',
  'update_elan',
  'select_toolchain',
] as const;
export type LeanProjectCommand = (typeof LEAN_PROJECT_COMMANDS)[number];

/** Human-readable label for each server mode (used in the dashboard surface). */
export const LEAN_SERVER_MODE_LABELS = {
  'vscode-extension': LEAN4_EXTENSION_ID,
  'direct-lsp': 'direct LSP',
} as const;
