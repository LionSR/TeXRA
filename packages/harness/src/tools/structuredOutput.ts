// Third-party imports
import {
  Effect,
  JsonSchema,
  Predicate,
  Schema,
  SchemaRepresentation,
} from 'effect';

// Internal imports
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import {
  convertToolSchema,
  type JSONSchemaObject,
} from '@agent/core/tools/toolSchema';
import {
  ToolError,
  JsonValueSchema,
  STRUCTURED_OUTPUT_TOOL_NAME,
  type ToolResult,
} from '@shared/schemas';

// Local file imports
import { defineTool } from './core/definition';

type StructuredOutputSchema = {
  readonly jsonSchema: JSONSchemaObject;
  readonly schema: Schema.Codec<unknown, unknown>;
};

// A sandbox schema is compiled on the host (`SchemaRepresentation.fromJsonSchemaDocument`),
// so an unbounded tree is a host DoS. These caps keep compilation cheap; 12
// levels / 1000 nodes comfortably cover real structured-output shapes while
// refusing pathological input.
const MAX_SANDBOX_SCHEMA_DEPTH = 12;
const MAX_SANDBOX_SCHEMA_NODES = 1000;
// The node/depth caps count object nodes only, so scalar-heavy keywords the
// walker does not recurse into (a million-element `enum`, huge `required` /
// `examples` / `description`) would still reach the compiler unbounded. A
// serialized-size cap bounds the whole payload; 128 KiB dwarfs any real schema.
const MAX_SANDBOX_SCHEMA_BYTES = 128 * 1024;

// Property names that could reach Object.prototype when the compiler builds
// the schema object.
const FORBIDDEN_SCHEMA_PROPERTY_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
];

// Schema keywords the walker recurses into, grouped by the shape of their
// value: a single subschema, an array of subschemas, or a record of them.
const SUBSCHEMA_KEYS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const SUBSCHEMA_LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SUBSCHEMA_RECORD_KEYS = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
  'properties',
];

/**
 * Guard a JSON Schema authored inside a workflow sandbox (untrusted) before it
 * is compiled on the host. Walking the schema it rejects:
 * `pattern`/`patternProperties`/`format` (compiled to host RegExps, a
 * catastrophic-backtracking ReDoS vector); `$ref`/`$dynamicRef`
 * (external/recursive resolution surprises; inline the definition instead);
 * prototype-polluting property keys; and trees past the node/depth caps.
 */
function assertSafeSandboxSchema(schema: unknown): void {
  if (JSON.stringify(schema).length > MAX_SANDBOX_SCHEMA_BYTES) {
    throw new Error(
      `Structured output JSON Schema exceeds the ${MAX_SANDBOX_SCHEMA_BYTES}-byte size limit.`,
    );
  }
  let nodeCount = 0;
  const walk = (node: unknown, depth: number): void => {
    if (!Predicate.isObjectOrArray(node)) return;
    if (depth > MAX_SANDBOX_SCHEMA_DEPTH) {
      throw new Error(
        `Structured output JSON Schema is nested deeper than the ${MAX_SANDBOX_SCHEMA_DEPTH}-level limit.`,
      );
    }
    nodeCount += 1;
    if (nodeCount > MAX_SANDBOX_SCHEMA_NODES) {
      throw new Error(
        `Structured output JSON Schema exceeds the ${MAX_SANDBOX_SCHEMA_NODES}-node limit.`,
      );
    }
    if (!Predicate.isObject(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const record = node;
    if ('pattern' in record || 'patternProperties' in record) {
      throw new Error(
        'Structured output JSON Schema cannot use pattern or patternProperties.',
      );
    }
    if ('format' in record) {
      throw new Error('Structured output JSON Schema cannot use format.');
    }
    if ('$ref' in record || '$dynamicRef' in record) {
      throw new Error(
        'Structured output JSON Schema cannot use $ref; inline the definition instead.',
      );
    }

    for (const key of SUBSCHEMA_KEYS) {
      walk(record[key], depth + 1);
    }
    for (const key of SUBSCHEMA_LIST_KEYS) {
      const branches = record[key];
      if (Array.isArray(branches)) {
        for (const branch of branches) walk(branch, depth + 1);
      }
    }
    for (const key of SUBSCHEMA_RECORD_KEYS) {
      const schemas = record[key];
      if (schemas !== null && typeof schemas === 'object') {
        for (const name of Object.keys(schemas)) {
          if (FORBIDDEN_SCHEMA_PROPERTY_KEYS.includes(name)) {
            throw new Error(
              `Structured output JSON Schema cannot declare a "${name}" property.`,
            );
          }
        }
        for (const child of Object.values(schemas)) walk(child, depth + 1);
      }
    }
  };
  walk(schema, 0);
}

/**
 * Normalize a structured-output schema at its boundary. Both live schemas and
 * sandbox JSON Schema land on the same validation path and the same
 * provider-facing object schema conversion. A sandbox schema is authored as
 * draft 2020-12, the dialect the provider-facing conversion emits.
 */
export function normalizeStructuredOutputSchema(
  input: Schema.Codec<unknown, unknown> | Record<string, unknown>,
): StructuredOutputSchema {
  let schema: Schema.Codec<unknown, unknown>;
  if (Schema.isSchema(input)) {
    schema = input;
  } else {
    assertSafeSandboxSchema(input);
    const compiled = SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft2020_12(input),
    );
    // A schema compiled from JSON Schema decodes plain JSON with no services;
    // cast: `fromJsonSchemaDocument` only states `Schema.Top`.
    schema = compiled as Schema.Codec<unknown, unknown>;
  }
  const jsonSchema = convertToolSchema({
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    schema,
  });
  if (jsonSchema?.type !== 'object') {
    const got =
      typeof jsonSchema?.type === 'string'
        ? `type "${jsonSchema.type}"`
        : 'no object root';
    throw new Error(
      `Structured output schema must be an object at the root (got ${got}). Wrap a scalar or array result in an object property.`,
    );
  }
  return { jsonSchema, schema };
}

/**
 * Build a terminal tool from a normalized structured-output schema.
 *
 * The guarantee is the tool layer's own spine: `defineTool` validates
 * the model's call before `execute` runs, and an invalid call surfaces a
 * `SchemaError` the model self-corrects. `execute` then enforces the persisted
 * JSON-value contract and returns it as the result's `value`: the settled
 * result is the run's structured output (`RunState.structured`).
 */
export function buildTerminalTool(
  input: Schema.Codec<unknown, unknown> | Record<string, unknown>,
): ITool<Error, never> {
  const { schema } = normalizeStructuredOutputSchema(input);

  // Built per run, so `captured` belongs to this run's loop alone.
  let captured = false;
  return defineTool<unknown, never>({
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description:
      'Submit the final result. Call this exactly once, with the complete result, when the task is done.',
    schema,
    // A repeated call and a malformed payload are the call's own failures,
    // the latter keeping its schema issues for the model's diagnostics.
    execute: (input) =>
      Effect.gen(function* () {
        if (captured) {
          return yield* Effect.fail(
            new ToolError('submit_output can only be accepted once per run.'),
          );
        }
        const value = yield* Schema.decodeUnknownEffect(JsonValueSchema)(input);
        captured = true;
        return {
          status: 'executed',
          endTurn: true,
          value,
          summary: 'Structured output captured.',
          output: 'Structured output captured.',
        } satisfies ToolResult;
      }),
  });
}
