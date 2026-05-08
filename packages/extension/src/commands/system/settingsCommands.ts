// Third-party imports
import type * as vscode from 'vscode';

// Local imports - utils
// The `settingsCommands.openSettings` id is kept here as a stable import
// surface for other modules; the actual command is now registered via the
// shared registry in `extensionCommandSurface.ts`. See the JSDoc on
// `registerSettingsCommands` below.

export const settingsCommands = {
  openSettings: 'texra.openSettings',
};

/**
 * `texra.openSettings` is now registered through the shared command
 * registry in `extensionCommandSurface.ts`. This stub is kept for the
 * existing `registerSettingsCommands(context)` call site; once every
 * caller migrates to the shared registry, the function can be deleted.
 */
export function registerSettingsCommands(
  _context: vscode.ExtensionContext,
): void {
  /* registration handled by extensionCommandSurface */
}
