// Third-party imports
import { z } from 'zod';

/**
 * VS Code extension–only settings.
 *
 * These settings are meaningful only when TeXRA runs inside VS Code:
 *
 * - `auth.enableVSCodeGitHub` literally toggles the VS Code GitHub
 *   authentication provider. Other hosts (CLI, Electron desktop) use
 *   different auth flows and ignore this key.
 * - `apiKeys.set` / `apiKeys.remove` are `null`-typed UI command triggers
 *   surfaced through VS Code's settings UI. They are not real configuration
 *   values; selecting them in the settings tree opens the API key dialog.
 *
 * Layered on top of {@link CoreSettingsSchema} via the composed
 * `TexraSettingsSchema` in `settingsConfiguration.ts`.
 */

export const DEFAULT_VSCODE_SETTINGS_EXTENSION = {
  auth: {
    enableVSCodeGitHub: false,
  },
  apiKeys: {
    set: null,
    remove: null,
  },
};

export const VscodeSettingsExtensionShape = {
  auth: z
    .strictObject({
      enableVSCodeGitHub: z
        .boolean()
        .prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.auth.enableVSCodeGitHub),
    })
    .prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.auth),
  apiKeys: z
    .strictObject({
      set: z.null().prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.apiKeys.set),
      remove: z
        .null()
        .prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.apiKeys.remove),
    })
    .prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION.apiKeys),
};

export const VscodeSettingsExtensionSchema = z
  .strictObject(VscodeSettingsExtensionShape)
  .prefault(DEFAULT_VSCODE_SETTINGS_EXTENSION);

export type VscodeSettingsExtension = z.infer<
  typeof VscodeSettingsExtensionSchema
>;
