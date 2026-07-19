// Third-party imports
import { z } from 'zod';

// Internal imports
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import { convertToolSchema } from '@agent/modelHandlers/toolConversion';
import type { ToolResult } from '@shared/schemas/toolResult';

// Local file imports
import { defineTool } from './core/define';

type StructuredOutputSchema<TSchema extends z.ZodType = z.ZodType> = {
  readonly jsonSchema: Record<string, unknown>;
  readonly zodSchema: TSchema;
};

const JsonValueSchema = z.json();
type JsonValue = z.infer<typeof JsonValueSchema>;

/** Name of the synthetic tool the model calls to submit its final result. */
const SUBMIT_OUTPUT_TOOL_NAME = 'submit_output';

// A sandbox schema crosses into host Zod compilation via z.fromJSONSchema, so
// an unbounded tree is a host DoS. These caps keep compilation cheap; 12 levels
// / 1000 nodes comfortably cover real structured-output shapes while refusing
// pathological input.
const MAX_SANDBOX_SCHEMA_DEPTH = 12;
const MAX_SANDBOX_SCHEMA_NODES = 1000;
// The node/depth caps count object nodes only, so scalar-heavy keywords the
// walker does not recurse into (a million-element `enum`, huge `required` /
// `examples` / `description`) would still reach z.fromJSONSchema unbounded. A
// serialized-size cap bounds the whole payload; 128 KiB dwarfs any real schema.
const MAX_SANDBOX_SCHEMA_BYTES = 128 * 1024;

// Property names that could reach Object.prototype when z.fromJSONSchema builds
// the schema object.
const FORBIDDEN_SCHEMA_PROPERTY_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
];

/**
 * Guard a JSON Schema authored inside a workflow sandbox (untrusted) before it
 * crosses into host Zod compilation via z.fromJSONSchema. Walking the schema it
 * rejects: `pattern`/`patternProperties`/`format` (Zod compiles these to host
 * RegExps, a catastrophic-backtracking ReDoS vector); `$ref`/`$dynamicRef`
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
    if (node === null || typeof node !== 'object') return;
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
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
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

    for (const key of [
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
    ]) {
      walk(record[key], depth + 1);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      const branches = record[key];
      if (Array.isArray(branches)) {
        for (const branch of branches) walk(branch, depth + 1);
      }
    }
    for (const key of [
      '$defs',
      'definitions',
      'dependentSchemas',
      'dependencies',
      'properties',
    ]) {
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
 * Normalize a structured-output schema at its boundary. Both live Zod schemas
 * and sandbox JSON Schema land on the same Zod validation path and the same
 * provider-facing object schema conversion.
 */
export function normalizeStructuredOutputSchema<TSchema extends z.ZodType>(
  input: TSchema,
): StructuredOutputSchema<TSchema>;
export function normalizeStructuredOutputSchema(
  input: z.ZodType | Record<string, unknown>,
): StructuredOutputSchema;
export function normalizeStructuredOutputSchema(
  input: z.ZodType | Record<string, unknown>,
): StructuredOutputSchema {
  const fromZod = input instanceof z.ZodType;
  if (!fromZod) assertSafeSandboxSchema(input);
  const zodSchema = fromZod ? input : (z.fromJSONSchema(input) as z.ZodType);
  const jsonSchema = convertToolSchema({
    name: SUBMIT_OUTPUT_TOOL_NAME,
    zodSchema,
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
  return { jsonSchema, zodSchema };
}

/**
 * Build a terminal tool from a normalized structured-output schema.
 *
 * The guarantee is the tool layer's own spine: `defineTool`/`BaseTool` validate
 * the model's call before `execute` runs, and an invalid call surfaces a
 * `ZodError` the model self-corrects. `execute` then enforces the persisted
 * JSON-value contract and hands the result to `capture`.
 *
 * `capture` is bound to instance state, not a module-level global, so
 * concurrent runs never share a sink.
 */
export function buildTerminalTool(
  input: z.ZodType | Record<string, unknown>,
  capture: (value: JsonValue) => void,
): ITool {
  const { zodSchema } = normalizeStructuredOutputSchema(input);

  const GeneratedTool = defineTool({
    name: SUBMIT_OUTPUT_TOOL_NAME,
    description:
      'Submit the final result. Call this exactly once, with the complete result, when the task is done.',
    schema: zodSchema,
  });

  class TerminalTool extends GeneratedTool {
    // Run-scoped capture slot bound to instance state, so concurrent workflow
    // runs never race on a shared sink.
    private readonly capture: (value: JsonValue) => void;
    private captured = false;

    constructor(capture: (value: JsonValue) => void) {
      super();
      this.capture = capture;
    }

    protected async execute(input: unknown): Promise<ToolResult> {
      if (this.captured) {
        throw new Error('submit_output can only be accepted once per run.');
      }
      const jsonValue = JsonValueSchema.parse(input);
      this.captured = true;
      this.capture(jsonValue);
      return {
        status: 'executed',
        endTurn: true,
        summary: 'Structured output captured.',
        output: 'Structured output captured.',
      };
    }
  }

  return new TerminalTool(capture);
}

/**
 * Wrap a base registry so `submit_output` resolves to the run-scoped terminal
 * tool while every other lookup delegates to `base`. The shared default
 * registry is never mutated, so concurrent runs never see one another's
 * terminal tool. Used by the tool-use flow to make the synthetic tool findable
 * by name (`toolRegistry.get('submit_output')`) alongside the real tools.
 */
export function buildTerminalToolRegistry(
  base: IToolRegistry,
  terminalTool: ITool,
): IToolRegistry {
  return {
    get: (name) =>
      name === SUBMIT_OUTPUT_TOOL_NAME ? terminalTool : base.get(name),
    has: (name) => name === SUBMIT_OUTPUT_TOOL_NAME || base.has(name),
  };
}
