/**
 * Provider-neutral tool parameter schemas: a tool definition's Effect Schema
 * or pre-built JSON Schema, normalized to the object shape every
 * function-calling API accepts (top-level unions flattened, the dialect URI
 * stripped, every array given an `items`). The tool catalog builds the
 * package's uniform tool definitions from it; the structured-output tool
 * builder shares it.
 */
import { Predicate, Schema } from 'effect';

import type { ToolDefinition } from '@shared/schemas';

/** A JSON Schema node as a provider's function-calling API reads it. */
export interface JSONSchemaObject {
  type?: string | string[];
  properties?: Record<string, JSONSchemaObject>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  oneOf?: JSONSchemaObject[];
  anyOf?: JSONSchemaObject[];
  allOf?: JSONSchemaObject[];
  items?: JSONSchemaObject | JSONSchemaObject[];
  $ref?: string;
  $schema?: string;
  $defs?: Record<string, JSONSchemaObject>;
  definitions?: Record<string, JSONSchemaObject>;
  additionalProperties?: boolean | JSONSchemaObject;
  [key: string]: unknown;
}

/** The one value a schema admits (`const`, a one-member `enum`), read
 *  through the `anyOf` a nullable optional field wraps it in: a branch's
 *  discriminator that takes a default is `Schema.optional(Schema.NullOr(L))`. */
function schemaLiteralValue(schema: JSONSchemaObject): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    return schema.enum[0];
  }
  const members = schema.anyOf?.filter((member) => member.type !== 'null');
  return members?.length === 1 ? schemaLiteralValue(members[0]) : undefined;
}

/**
 * Function-calling APIs reject a parameters schema whose top-level node is
 * `oneOf`/`anyOf`/`allOf` (HTTP 400: `schema must have type 'object' and
 * not contain 'oneOf'/'anyOf'/'allOf' at the top level`). Effect Schema
 * emits a union of structs as a top-level `anyOf`. Flatten such
 * unions into a single object schema by merging the union of all branch
 * properties, keeping only properties required by every branch as
 * `required`, and collapsing discriminator literals from every branch into
 * an `enum`. Properties that exist on multiple branches with conflicting
 * non-literal shapes fall back to the first branch's shape; the discriminator
 * enum is what the model actually selects between.
 */
function flattenTopLevelUnion(schema: JSONSchemaObject): JSONSchemaObject {
  const variantKey = (['oneOf', 'anyOf', 'allOf'] as const).find(
    (k) => Array.isArray(schema[k]) && schema.type !== 'object',
  );
  if (!variantKey) return schema;

  const rawVariants: readonly unknown[] = schema[variantKey] ?? [];
  const variants = rawVariants.filter(
    (v): v is JSONSchemaObject => Predicate.isObject(v) && v.type === 'object',
  );
  if (variants.length === 0 || variants.length !== rawVariants.length) {
    return schema;
  }

  const variantProperties: Record<string, JSONSchemaObject>[] = variants.map(
    (v) => v.properties ?? {},
  );

  const allPropNames = new Set(
    variantProperties.flatMap((props) => Object.keys(props)),
  );

  const mergedProperties: Record<string, JSONSchemaObject> = {};
  for (const name of allPropNames) {
    const branchSchemas = variantProperties
      .map((props) => props[name])
      .filter((s): s is JSONSchemaObject => s !== undefined);
    if (branchSchemas.length === 1) {
      mergedProperties[name] = branchSchemas[0];
      continue;
    }
    // Discriminator: every branch pins this prop to a literal value.
    const constValues = branchSchemas
      .map(schemaLiteralValue)
      .filter((value) => value !== undefined);
    if (constValues.length === branchSchemas.length) {
      const descriptions = branchSchemas
        .map((s) => s.description)
        .filter((d): d is string => typeof d === 'string');
      // Infer the discriminator type from the branch shapes rather than
      // hardcoding 'string': a literal discriminator may also be a number
      // or a boolean.
      const branchType = branchSchemas
        .map((s) => (typeof s.type === 'string' ? s.type : undefined))
        .find((t): t is string => t !== undefined);
      const inferredType = branchType ?? typeof constValues[0];
      const merged: JSONSchemaObject = {
        type: inferredType,
        enum: constValues,
      };
      if (descriptions.length) {
        merged.description = descriptions.join(' | ');
      }
      mergedProperties[name] = merged;
      continue;
    }
    mergedProperties[name] = branchSchemas[0];
  }

  const requiredSets = variants.map((v) => new Set<string>(v.required ?? []));
  const commonRequired = [...allPropNames].filter((p) =>
    requiredSets.every((s) => s.has(p)),
  );

  const flat: JSONSchemaObject = {
    type: 'object',
    properties: mergedProperties,
  };
  if (commonRequired.length) flat.required = commonRequired;
  if (typeof schema.description === 'string') {
    flat.description = schema.description;
  }
  return flat;
}

/**
 * OpenAI and Gemini both reject `$schema` at the top level of function
 * parameter schemas. Effect Schema keeps the dialect outside the schema, but
 * a pre-built `parameters` document (an MCP server's) may carry the URI.
 * Strip it for any provider.
 */
function stripDollarSchema(schema: JSONSchemaObject): JSONSchemaObject {
  if (!('$schema' in schema)) return schema;
  const { $schema: _unused, ...rest } = schema;
  return rest;
}

/** Keywords whose value is data, never a schema to walk. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  'enum',
  'const',
  'default',
  'examples',
]);

/**
 * OpenAI rejects an array schema without an `items` schema, strict mode or
 * not (HTTP 400: `array schema missing items`), and takes neither
 * `prefixItems` nor the legacy array form of `items`. Effect Schema emits a
 * tuple (`view_range`) as `prefixItems` with `minItems`/`maxItems`, and
 * `Schema.Array(Schema.Unknown)` as a bare `{ type: 'array' }`. Every array
 * therefore names one `items` schema: a tuple's element schemas (one, or
 * `anyOf` the distinct ones) with its length as the bounds it does not
 * declare, and an untyped array `{}`. Dispatch still validates the call
 * against the tool's own schema.
 *
 * The same walk drops two things Effect Schema emits that no provider saw
 * before: `additionalProperties: true` on every struct (the JSON Schema
 * default, so dropping it changes nothing for a validator; the harness
 * never tells a model an object is closed) and the duplicate `null` member
 * of `Schema.optional(Schema.NullOr(S))`, which encodes both the absent and
 * the null case as `{ type: 'null' }`.
 */
function withArrayItems(node: JSONSchemaObject): JSONSchemaObject;
function withArrayItems(node: unknown): unknown;
function withArrayItems(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withArrayItems);
  if (!Predicate.isObject(node)) return node;
  const walkedValue = (key: string, value: unknown): unknown => {
    if (DATA_KEYWORDS.has(key)) return value;
    if (key === 'anyOf' && Array.isArray(value))
      return distinct(value.map(withArrayItems));
    return withArrayItems(value);
  };
  const walked = Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key, value]) => key !== 'additionalProperties' || value !== true,
      )
      .map(([key, value]) => [key, walkedValue(key, value)]),
  );
  const { type, prefixItems, items, ...rest } = walked;
  if (![type].flat().includes('array')) return walked;
  // The legacy tuple form is `items: [...]`.
  const tuple = Array.isArray(items) ? items : prefixItems;
  if (!Array.isArray(tuple)) return { items: {}, ...walked };
  // A schema `items` beside `prefixItems` types the elements past the tuple.
  const tail = Predicate.isObject(items) ? [items] : [];
  const elements = distinct([...tuple, ...tail]);
  return {
    type,
    ...rest,
    items: elements.length > 1 ? { anyOf: elements } : (elements[0] ?? {}),
    // Declared bounds stand; a tuple without them is exactly its length.
    minItems: rest.minItems ?? tuple.length,
    ...(tail.length > 0 || rest.maxItems !== undefined
      ? {}
      : { maxItems: tuple.length }),
  };
}

/** The schemas of `nodes` with structural duplicates dropped, first kept. */
const distinct = (nodes: readonly unknown[]): unknown[] => [
  ...new Map(nodes.map((node) => [JSON.stringify(node), node])).values(),
];

/** A tool's input as JSON Schema, unflattened: its Effect Schema converted
 *  (its definitions, if any, attached as `$defs`, where the emitted `$ref`s
 *  point), else its pre-converted parameters. */
export const inputSchema = (definition: ToolDefinition): unknown => {
  if (definition.schema === undefined) return definition.parameters;
  const { schema, definitions } = Schema.toJsonSchemaDocument(
    definition.schema,
  );
  return Object.keys(definitions).length === 0
    ? schema
    : { ...schema, $defs: definitions };
};

/**
 * Converts an Effect Schema to JSON Schema, or returns the pre-converted
 * parameters: top-level unions are flattened, every array
 * names its `items`, and `$schema` is stripped so the output passes every
 * provider's schema validator.
 */
export function convertToolSchema(
  def: ToolDefinition,
): JSONSchemaObject | null {
  // Effect's JSON Schema output and a tool's pre-built parameters are read
  // below as the JSON Schema documents they are.
  // cast: both sources are typed only as string-keyed records.
  const schema = inputSchema(def) as JSONSchemaObject | null | undefined;
  if (!schema) return null;
  return withArrayItems(stripDollarSchema(flattenTopLevelUnion(schema)));
}
