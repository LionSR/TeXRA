// Third-party imports
import { z } from 'zod';

// Internal imports
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import { convertToolSchema } from '@agent/modelHandlers/toolConversion';
import type { ToolResult } from '@shared/schemas/toolResult';

// Local file imports
import { defineTool } from './core/define';

/**
 * Dual-shape description of a structured-output target, mirroring
 * {@link import('@model/ToolDefinition').ToolDefinition}: a JSON Schema for
 * provider payloads and the original Zod schema for the single validation site.
 *
 * `validate` is a closure over `zodSchema.safeParse`, so structured-output
 * validation routes through the exact same Zod parse the tool layer uses; no
 * second parallel validator is introduced.
 */
export type StructuredOutputSpec = {
  /** Logical name of the output (used for the terminal tool and diagnostics). */
  name: string;
  /** JSON Schema form, for provider-native structured output later. */
  jsonSchema: Record<string, unknown>;
  /** Original Zod schema, the single source of truth for validation. */
  zodSchema: z.ZodType;
  /** Validate a raw value against `zodSchema` without throwing. */
  validate(raw: unknown): z.ZodSafeParseResult<unknown>;
};

/**
 * Resolve a structured-output spec from either a Zod schema (host callers) or a
 * plain JSON Schema object (sandbox callers).
 *
 * - A Zod schema keeps `zodSchema = input` and derives `jsonSchema` through
 *   `convertToolSchema`, reusing the same `toJSONSchema` options and top-level
 *   union / `$schema` normalization the tool converters use.
 * - A JSON Schema object keeps `jsonSchema = input` and derives `zodSchema` via
 *   `z.fromJSONSchema`, so both callers land on one Zod validation site.
 */
export function resolveStructuredOutput(
  input: z.ZodType | Record<string, unknown>,
  name = 'output',
): StructuredOutputSpec {
  const fromZod = input instanceof z.ZodType;
  const zodSchema = fromZod ? input : (z.fromJSONSchema(input) as z.ZodType);
  const jsonSchema = fromZod
    ? (convertToolSchema({ name, zodSchema }) ?? {})
    : input;
  return {
    name,
    jsonSchema,
    zodSchema,
    validate: (raw) => zodSchema.safeParse(raw),
  };
}

/** Name of the synthetic tool the model calls to submit its final result. */
const SUBMIT_OUTPUT_TOOL_NAME = 'submit_output';

/**
 * Build a synthetic terminal tool whose schema is the spec's Zod schema.
 *
 * The guarantee is the tool layer's own spine: `defineTool`/`BaseTool` validate
 * the model's call against `spec.zodSchema` before `execute` runs, and an
 * invalid call surfaces a `ZodError` the model self-corrects. So `execute`
 * receives already-validated input and simply hands it to `capture`.
 *
 * `capture` is bound to instance state, not a module-level global, so
 * concurrent runs never share a sink.
 */
export function buildTerminalTool(
  spec: StructuredOutputSpec,
  capture: (value: unknown) => void,
): ITool {
  // Provider tool inputs (and native structured output) require an object at the
  // root; a scalar or array root would be rejected at request time. Fail here
  // with a clear message instead, so a caller wraps the value in a property.
  if (spec.jsonSchema.type !== 'object') {
    const got =
      typeof spec.jsonSchema.type === 'string'
        ? `type "${spec.jsonSchema.type}"`
        : 'no root type';
    throw new Error(
      `Structured output schema must be an object at the root (got ${got}). Wrap a scalar or array result in an object property.`,
    );
  }

  const GeneratedTool = defineTool({
    name: SUBMIT_OUTPUT_TOOL_NAME,
    description:
      'Submit the final result. Call this exactly once, with the complete result, when the task is done.',
    schema: spec.zodSchema,
  });

  class TerminalTool extends GeneratedTool {
    // Run-scoped capture slot bound to instance state, so concurrent workflow
    // runs never race on a shared sink.
    private readonly capture: (value: unknown) => void;

    constructor(capture: (value: unknown) => void) {
      super();
      this.capture = capture;
    }

    protected async execute(input: unknown): Promise<ToolResult> {
      this.capture(input);
      return {
        status: 'executed',
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

/**
 * JSON Schema keywords provider strict-mode structured output rejects. Presence
 * of any of these means native forcing must not be attempted for the schema.
 */
const STRICT_INCOMPATIBLE_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
] as const;

/**
 * Keywords whose presence means a schema node constrains its value. A node with
 * none of these (a bare `{}`, or the `{}` fallback when `convertToolSchema`
 * returns null) accepts any value, which strict native output cannot represent.
 */
const CONSTRAINT_KEYWORDS = [
  'type',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  'enum',
  'const',
] as const;

/**
 * Whether the spec's JSON Schema is compatible with provider strict-mode native
 * structured output. Consumed later (Phase 2) to decide whether to attempt
 * native forcing.
 *
 * Returns false when the schema uses numeric/string constraint keywords, or an
 * object node that allows extra properties or has an optional (not required)
 * property, since strict mode requires every property required and
 * `additionalProperties: false`.
 */
export function isStrictNativeCompatible(spec: StructuredOutputSpec): boolean {
  return isNodeStrictNativeCompatible(spec.jsonSchema);
}

function isNodeStrictNativeCompatible(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return true;
  const schema = node as Record<string, unknown>;

  for (const keyword of STRICT_INCOMPATIBLE_KEYWORDS) {
    if (keyword in schema) return false;
  }

  const isObjectNode = schema.type === 'object' || 'properties' in schema;
  if (isObjectNode) {
    // Strict mode requires objects to forbid extra properties and mark every
    // property required. A bare { type: 'object' } (no properties, no
    // additionalProperties: false) still accepts arbitrary fields.
    if (schema.additionalProperties !== false) return false;
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (properties && typeof properties === 'object') {
      const required = new Set(
        Array.isArray(schema.required) ? (schema.required as string[]) : [],
      );
      for (const key of Object.keys(properties)) {
        if (!required.has(key)) return false;
        if (!isNodeStrictNativeCompatible(properties[key])) return false;
      }
    }
  } else if (!CONSTRAINT_KEYWORDS.some((keyword) => keyword in schema)) {
    return false;
  }

  for (const key of ['items', 'additionalItems', 'not'] as const) {
    if (!isNodeStrictNativeCompatible(schema[key])) return false;
  }
  for (const key of ['prefixItems', 'anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (
      Array.isArray(branches) &&
      !branches.every((branch) => isNodeStrictNativeCompatible(branch))
    ) {
      return false;
    }
  }
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = schema[key];
    if (defs && typeof defs === 'object') {
      for (const value of Object.values(defs as Record<string, unknown>)) {
        if (!isNodeStrictNativeCompatible(value)) return false;
      }
    }
  }
  return true;
}
