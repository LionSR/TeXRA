// Local imports
import {
  CORE_SETTING_PATHS,
  type CoreSettingPath,
} from '@shared/schemas/coreSettings';

/**
 * Typed, catalog-derived setting keys and accessor map.
 *
 * `CORE_SETTING_PATHS` (generated from `CoreSettingsShape`, see
 * `coreSettings.ts`) is the single source of truth for every host-neutral
 * setting's dotted path. Reading a setting via a hand-typed string literal
 * (`getConfig('texra.bib.defaultPath', ...)`) survives a catalog rename —
 * `getConfig` only asserts a type, it never checks the key exists. `SETTING_KEY`
 * closes that gap: a rename that drops a `CoreSettingPath` entry makes every
 * `SETTING_KEY[...]` call site referencing the old path a compile error instead
 * of a silently-dead setting read.
 *
 * Prefer `SETTING_KEY['bib.defaultPath']` over the string literal
 * `'texra.bib.defaultPath'` at `getConfig` / `updateConfig` /
 * `platform().config` call sites for settings declared in
 * {@link CORE_SETTING_PATHS}.
 */

export type CoreSettingKey = `texra.${CoreSettingPath}`;

export const SETTING_KEY: Readonly<Record<CoreSettingPath, CoreSettingKey>> =
  Object.fromEntries(
    CORE_SETTING_PATHS.map((path) => [path, `texra.${path}` as CoreSettingKey]),
  ) as Record<CoreSettingPath, CoreSettingKey>;
