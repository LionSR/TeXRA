/**
 * Layered TeXRA settings schemas.
 *
 * - {@link CoreSettingsSchema} — host-neutral settings; valid in any host.
 * - {@link VscodeSettingsExtensionSchema} — VS Code-only add-ons.
 * - {@link DesktopSettingsExtensionSchema} — Electron desktop-only add-ons.
 * - {@link CliSettingsExtensionSchema} — CLI-only runtime fields.
 *
 * The fully composed VS Code schema (`TexraSettingsSchema`) lives in
 * `settingsConfiguration.ts` together with the derived flattener, defaults,
 * and JSON-schema generator used to populate the extension's package.json
 * configuration contributions.
 */

export * from './coreSettings';
export * from './vscodeSettings';
export * from './desktopSettings';
export * from './cliSettings';
