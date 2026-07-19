// Third-party imports
import { z } from 'zod';

// Internal imports
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import { convertToolSchema } from '@agent/modelHandlers/toolConversion';
import type { ToolResult } from '@shared/schemas/toolResult';

// Local file imports
import { defineTool } from './core/define';

type StructuredOutputSchema = {
  readonly jsonSchema: Record<string, unknown>;
  readonly zodSchema: z.ZodType;
};

const JsonValueSchema = z.json();
type JsonValue = z.infer<typeof JsonValueSchema>;

/** Name of the synthetic tool the model calls to submit its final result. */
const SUBMIT_OUTPUT_TOOL_NAME = 'submit_output';

/**
 * JSON Schema authored inside a workflow sandbox is untrusted. Zod compiles
 * these keywords to host RegExp instances, where catastrophic backtracking
 * would escape the sandbox's execution limits.
 */
function assertNoHostRegex(schema: unknown): void {
  if (schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    for (const child of schema) assertNoHostRegex(child);
    return;
  }
  const record = schema as Record<string, unknown>;
  if ('pattern' in record || 'patternProperties' in record) {
    throw new Error(
      'Structured output JSON Schema cannot use pattern or patternProperties.',
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
    assertNoHostRegex(record[key]);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const branches = record[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) assertNoHostRegex(branch);
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
      for (const child of Object.values(schemas)) assertNoHostRegex(child);
    }
  }
}

/**
 * Normalize a structured-output schema at its boundary. Both live Zod schemas
 * and sandbox JSON Schema land on the same Zod validation path and the same
 * provider-facing object schema conversion.
 */
export function normalizeStructuredOutputSchema(
  input: z.ZodType | Record<string, unknown>,
): StructuredOutputSchema {
  const fromZod = input instanceof z.ZodType;
  if (!fromZod) assertNoHostRegex(input);
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
