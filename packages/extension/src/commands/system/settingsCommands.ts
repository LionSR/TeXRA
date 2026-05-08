// Third-party imports
import type * as vscode from 'vscode';

// Local imports - utils
// Path constant kept here so other modules continue to import it without
// pulling in the (now-empty) command registration shim.

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
