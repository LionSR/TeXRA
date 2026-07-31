// Third-party imports
import { z } from 'zod';

/**
 * VS Code extension–only settings.
 *
 * These settings are meaningful only when TeXRA runs inside VS Code:
 *
 * - `apiKeys.set` / `apiKeys.remove` are `null`-typed UI command triggers
 *   surfaced through VS Code's settings UI. They are not real configuration
 *   values; selecting them in the settings tree opens the API key dialog.
 *
 * Layered on top of {@link CoreSettingsSchema} via the composed
 * `TexraSettingsSchema` in `texraSettings.ts`.
 */

export const DEFAULT_VSCODE_SETTINGS_EXTENSION = {
  apiKeys: {
    set: null,
    remove: null,
  },
};

export const VscodeSettingsExtensionShape = {
  apiKeys: z
    .strictObject({
      set: z.null().prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.apiKeys.set),
      remove: z
        .null()
        .prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.apiKeys.remove),
    })
    .prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.apiKeys),
};

/**
 * Dotted leaf paths for every VS Code-only setting.
 */
export const VSCODE_SETTING_PATHS = ['apiKeys.set', 'apiKeys.remove'] as const;
