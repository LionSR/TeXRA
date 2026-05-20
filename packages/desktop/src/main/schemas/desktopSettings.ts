// Third-party imports
import { z } from 'zod';

/**
 * Electron desktop–only settings.
 *
 * This file declares the per-host extension surface for the Electron
 * desktop app. The schema is currently empty: the only desktop-specific
 * setting in TeXRA today (`texra.desktop.crashReporting.enabled`) lives in
 * the global state store via `GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED`,
 * not in the settings tree.
 *
 * Reserved for future desktop-only entries (window placement, native theme
 * overrides, dock badge behavior, etc.). When a desktop-only setting is
 * added, declare it here and compose `DesktopSettingsSchema` as
 * `CoreSettingsSchema` + this extension — mirroring `TexraSettingsSchema`.
 */

export const DEFAULT_DESKTOP_SETTINGS_EXTENSION = {} as const;

export const DesktopSettingsExtensionShape = {} as const;

export const DesktopSettingsExtensionSchema = z
  .strictObject(DesktopSettingsExtensionShape)
  .prefault(DEFAULT_DESKTOP_SETTINGS_EXTENSION);

export type DesktopSettingsExtension = z.infer<
  typeof DesktopSettingsExtensionSchema
>;
