/**
 * Provider-neutral tool parameter schemas: a tool definition's Zod schema or
 * pre-built JSON Schema, normalized to the object shape every function-calling
 * API accepts (top-level discriminated unions flattened, the dialect URI
 * stripped). The tool catalog builds the package's uniform tool
 * definitions from it; the structured-output tool builder shares it.
 */
import { Predicate } from 'effect';
import { toJSONSchema } from 'zod';

import type { ToolDefinition } from '@shared/schemas';
import { TOOL_JSON_SCHEMA_OPTIONS } from '@shared/tools/toolJsonSchema';

interface JSONSchemaObject {
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

function schemaLiteralValue(schema: JSONSchemaObject): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    return schema.enum[0];
  }
  return undefined;
}

/**
 * Function-calling APIs reject a parameters schema whose top-level node is
 * `oneOf`/`anyOf`/`allOf` (HTTP 400: `schema must have type 'object' and
 * not contain 'oneOf'/'anyOf'/'allOf' at the top level`). Zod v4's
 * `toJSONSchema` emits discriminated unions exactly that way. Flatten such
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

  const rawVariants = schema[variantKey] as unknown[];
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
      // hardcoding 'string': Zod discriminated unions also accept numeric
      // and boolean literal discriminators.
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
 * parameter schemas. Zod v4's `toJSONSchema` includes this dialect URI by
 * default. Strip it for any provider.
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
 * `prefixItems` nor the legacy array form of `items`. Zod v4 emits a tuple
 * (`view_range`) as `prefixItems` alone. Every array therefore names one
 * `items` schema: a tuple's element schemas (one, or `anyOf` the distinct
 * ones) with its length as the bounds it does not declare, and an untyped
 * array `{}`. Dispatch still validates the call against the tool's own
 * schema.
 */
function withArrayItems(node: JSONSchemaObject): JSONSchemaObject;
function withArrayItems(node: unknown): unknown;
function withArrayItems(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withArrayItems);
  if (!Predicate.isObject(node)) return node;
  const walked = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      DATA_KEYWORDS.has(key) ? value : withArrayItems(value),
    ]),
  );
  const { type, prefixItems, items, ...rest } = walked;
  if (![type].flat().includes('array')) return walked;
  // The legacy tuple form is `items: [...]`.
  const tuple = Array.isArray(items) ? items : prefixItems;
  if (!Array.isArray(tuple)) return { items: {}, ...walked };
  // A schema `items` beside `prefixItems` types the elements past the tuple.
  const tail = Predicate.isObject(items) ? [items] : [];
  const elements = [
    ...new Map(
      [...tuple, ...tail].map((schema) => [JSON.stringify(schema), schema]),
    ).values(),
  ];
  return {
    type,
    ...rest,
    items: elements.length > 1 ? { anyOf: elements } : (elements[0] ?? {}),
    // Declared bounds stand; Zod states none, meaning exactly the tuple.
    minItems: rest.minItems ?? tuple.length,
    ...(tail.length > 0 || rest.maxItems !== undefined
      ? {}
      : { maxItems: tuple.length }),
  };
}

/**
 * Converts a Zod schema to JSON Schema, or returns the pre-converted
 * parameters: top-level discriminated unions are flattened, every array
 * names its `items`, and `$schema` is stripped so the output passes every
 * provider's schema validator.
 */
export function convertToolSchema(
  def: ToolDefinition,
): JSONSchemaObject | null {
  let schema: JSONSchemaObject | null;
  if (def.zodSchema) {
    schema = toJSONSchema(
      def.zodSchema,
      TOOL_JSON_SCHEMA_OPTIONS,
    ) as JSONSchemaObject;
  } else {
    schema = (def.parameters ?? null) as JSONSchemaObject | null;
  }
  if (!schema) return null;
  return withArrayItems(stripDollarSchema(flattenTopLevelUnion(schema)));
}
