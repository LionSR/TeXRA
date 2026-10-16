/**
 * What TeXRA's settings UIs read off a catalog row: the config-tree row
 * builder its own rows use, the row's schema without its default, the enum
 * choices a dropdown lists, and the label a Plugins-page card shows. Plain
 * functions of a row, so the extension webview, the desktop renderer and the
 * CLI `/config` panel render the same choices.
 */
import { z } from 'zod';

import type {
  StateSettingEntry,
  SurfacedSettingEntry,
} from '@shared/state/stateSettings';

/** A row a plugin declares, with the short label its Plugins-page card shows
 *  (the card already names the plugin, so 'Model' rather than 'Codex model'). */
export interface PluginSettingRow {
  readonly row: SurfacedSettingEntry;
  readonly label: string;
}

/**
 * Config-file-backed rows from a record keyed by dotted path under `texra.`:
 * the key and the uniform `config` slot are derived, not restated. The
 * record's declaration order is the catalog order.
 */
export function configTreeRows(
  rows: Readonly<Record<string, Omit<StateSettingEntry, 'key' | 'slot'>>>,
): StateSettingEntry[] {
  return Object.entries(rows).map(([path, row]) => ({
    ...row,
    key: `texra.${path}`,
    slot: 'config',
  }));
}

/** The entry's schema with the outer `.prefault()` wrapper peeled off. */
export function settingSchemaWithoutPrefault(
  entry: StateSettingEntry,
): unknown {
  return entry.schema instanceof z.ZodPrefault
    ? entry.schema.unwrap()
    : entry.schema;
}

/**
 * Enum option values for a setting, derived from its `z.enum(...)` schema (via
 * the public `.unwrap().options`) rather than restated on the row, or
 * `undefined` for non-enum settings. The schema stays the single source of the
 * allowed values; only the per-value prose (`enumDescriptions`) is editorial.
 */
export function settingEnumOptions(
  entry: StateSettingEntry,
): readonly string[] | undefined {
  const inner = settingSchemaWithoutPrefault(entry);
  return inner instanceof z.ZodEnum
    ? (inner.options as readonly string[])
    : undefined;
}

export interface SettingEnumChoice<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

/** Enum values paired with display metadata for settings UIs. */
export function settingEnumChoices<T extends string = string>(
  entry: StateSettingEntry,
): readonly SettingEnumChoice<T>[] | undefined {
  const values = settingEnumOptions(entry);
  if (!values) return undefined;
  return values.map((value, index) => ({
    value: value as T,
    label: entry.enumLabels?.[index] ?? value,
    ...(entry.enumDescriptions?.[index] && {
      description: entry.enumDescriptions[index],
    }),
  }));
}
