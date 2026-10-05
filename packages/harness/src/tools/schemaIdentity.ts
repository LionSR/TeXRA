/**
 * A JSON Schema's identity, apart from its wording: what a tool's identity
 * digest covers (`toolDigests` in `@tools/catalogEntries`), so a reworded
 * description never invalidates a call the model already made.
 */
import { isObject } from '@utils/core';

/** Keywords whose value is one schema, or an array of schemas. */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'prefixItems',
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'contentSchema',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'anyOf',
  'oneOf',
  'allOf',
]);

/** Keywords whose value maps a name to a schema: keys are data, kept as is. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);

/**
 * A JSON Schema node with `description` dropped at every schema position. It
 * walks keywords, not keys: a property named `description` stays, and
 * `enum`/`const`/`default` values are data and are not entered.
 */
export function withoutSchemaDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutSchemaDescriptions);
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'description') continue;
    if (SUBSCHEMA_KEYWORDS.has(keyword)) {
      out[keyword] = withoutSchemaDescriptions(value);
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          withoutSchemaDescriptions(schema),
        ]),
      );
    } else {
      out[keyword] = value;
    }
  }
  return out;
}
