/**
 * What TeXRA's settings UIs read off a catalog row: the row's schema without its default, the enum
 * choices a dropdown lists, and the label a Plugins-page card shows. Plain
 * functions of a row, so the extension webview, the desktop renderer and the
 * CLI `/config` panel render the same choices.
 */
import { Predicate, Schema, SchemaAST } from 'effect';

import type { TexraSettingRow } from '@texra/shared/settingsView/settingSurfaces';
import type { SettingRow } from '@texra-ai/harness/schemas';

/** A row a plugin declares, with the short label its Plugins-page card shows
 *  (the card already names the plugin, so 'Model' rather than 'Codex model'). */
export interface PluginSettingRow {
  readonly row: TexraSettingRow;
  readonly label: string;
}

/**
 * The entry's schema with its decoding default removed: the shape a value that
 * is present must match, which is what a wire payload or a write carries.
 */
export function settingSchemaWithoutDefault(
  entry: SettingRow,
): Schema.Codec<unknown> {
  return Schema.toType(entry.schema);
}

/**
 * Enum option values for a setting, read off its `Schema.Literals(...)` AST (a
 * union whose members are all string literals) rather than restated on the
 * row, or `undefined` for non-enum settings. The schema stays the single
 * source of the allowed values; only the per-value copy (`choices`) is
 * editorial.
 */
export function settingEnumOptions(
  entry: SettingRow,
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

/**
 * The bounds a number row's schema holds (`Schema.isBetween` and its
 * relatives), read back from its JSON Schema, so a number widget states
 * neither. A nullable number row's bounds are those of its number member.
 */
export function settingNumberBounds(entry: SettingRow): {
  readonly min?: number;
  readonly max?: number;
} {
  const { schema } = Schema.toJsonSchemaDocument(Schema.toType(entry.schema));
  const members: readonly unknown[] = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : [schema];
  const numeric = members.find(
    (member): member is Readonly<Record<string, unknown>> =>
      Predicate.isObject(member) &&
      (member.type === 'integer' || member.type === 'number'),
  );
  return {
    ...(typeof numeric?.minimum === 'number' && { min: numeric.minimum }),
    ...(typeof numeric?.maximum === 'number' && { max: numeric.maximum }),
  };
}

export interface SettingEnumChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** Enum values paired with the row's copy for each, for settings UIs. */
export function settingEnumChoices(
  entry: SettingRow,
): readonly SettingEnumChoice[] | undefined {
  return settingEnumOptions(entry)?.map((value) => {
    const copy = entry.choices?.[value];
    return {
      value,
      label: copy?.label ?? value,
      ...(copy?.description !== undefined && {
        description: copy.description,
      }),
    };
  });
}
