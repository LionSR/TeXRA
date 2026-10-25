/**
 * What TeXRA's settings UIs read off a catalog row: the row's schema without its default, the enum
 * choices a dropdown lists, and the label a Plugins-page card shows. Plain
 * functions of a row, so the extension webview, the desktop renderer and the
 * CLI `/config` panel render the same choices.
 */
import { Schema, SchemaAST } from 'effect';

import type {
  StateSettingEntry,
  SurfacedSettingEntry,
} from '@texra-ai/harness/schemas';

/** A row a plugin declares, with the short label its Plugins-page card shows
 *  (the card already names the plugin, so 'Model' rather than 'Codex model'). */
export interface PluginSettingRow {
  readonly row: SurfacedSettingEntry;
  readonly label: string;
}

/**
 * The entry's schema with its decoding default removed: the shape a value that
 * is present must match, which is what a wire payload or a write carries.
 */
export function settingSchemaWithoutPrefault(
  entry: StateSettingEntry,
): Schema.Codec<unknown> {
  return Schema.toType(entry.schema);
}

/**
 * Enum option values for a setting, read off its `Schema.Literals(...)` AST (a
 * union whose members are all string literals) rather than restated on the
 * row, or `undefined` for non-enum settings. The schema stays the single
 * source of the allowed values; only the per-value prose (`enumDescriptions`)
 * is editorial.
 */
export function settingEnumOptions(
  entry: StateSettingEntry,
): readonly string[] | undefined {
  const ast = SchemaAST.toType(entry.schema.ast);
  if (!SchemaAST.isUnion(ast)) return undefined;
  const values: string[] = [];
  for (const member of ast.types) {
    if (!SchemaAST.isLiteral(member) || typeof member.literal !== 'string') {
      return undefined;
    }
    values.push(member.literal);
  }
  return values;
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
