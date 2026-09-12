/**
 * Provider-neutral tool parameter schemas: a tool definition's Zod schema or
 * pre-built JSON Schema, normalized to the object shape every function-calling
 * API accepts (top-level discriminated unions flattened, the dialect URI
 * stripped). The run's `Tools` service builds the package's uniform tool
 * definitions from it; the provider converters of the handler tree share it
 * until that tree is deleted.
 */
import { toJSONSchema } from 'zod';

import type { ToolDefinition } from '@shared/schemas';
import { TOOL_JSON_SCHEMA_OPTIONS } from '@shared/tools/toolJsonSchema';
import { isObject } from '@utils/core';

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

export function isSchemaObject(value: unknown): value is JSONSchemaObject {
  return isObject(value);
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
export function flattenTopLevelUnion(
  schema: JSONSchemaObject,
): JSONSchemaObject {
  const variantKey = (['oneOf', 'anyOf', 'allOf'] as const).find(
    (k) => Array.isArray(schema[k]) && schema.type !== 'object',
  );
  if (!variantKey) return schema;

  const rawVariants = schema[variantKey] as unknown[];
  const variants = rawVariants.filter(
    (v): v is JSONSchemaObject => isSchemaObject(v) && v.type === 'object',
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
export function stripDollarSchema(schema: JSONSchemaObject): JSONSchemaObject {
  if (!('$schema' in schema)) return schema;
  const { $schema: _unused, ...rest } = schema;
  return rest;
}

/**
 * Converts a Zod schema to JSON Schema, or returns the pre-converted
 * parameters: top-level discriminated unions are flattened and `$schema` is
 * stripped so the output passes every provider's schema validator.
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
  return stripDollarSchema(flattenTopLevelUnion(schema));
}
