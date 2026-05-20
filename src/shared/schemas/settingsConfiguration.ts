/**
 * Backward-compatible re-export shim.
 *
 * The host-neutral settings schema (defaults, shape, types) now lives in
 * {@link ../coreSettings} and is the canonical entry point. The VS Code-facing
 * composed schema, JSON-schema generator, and flattener moved to
 * `packages/extension/src/schemas/texraSettings.ts` because they are
 * extension-specific tooling.
 *
 * This shim re-exports the core surface so legacy consumers that still import
 * from `@shared/schemas/settingsConfiguration` keep working. New code should
 * import directly from `@shared/schemas/coreSettings` (host-neutral) or from
 * `@extensionSchemas/texraSettings` (VS Code-composed).
 */

export {
  CoreSettingsSchema,
  CoreSettingsShape,
  DEFAULT_CORE_SETTINGS,
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
  type CoreSettings,
  type LatexdiffTempFileLocation,
  type NonRegexReplacementCategory,
  type RegexReplacementCategory,
} from './coreSettings';
