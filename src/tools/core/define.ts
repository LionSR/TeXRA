// Third-party imports
import { toJSONSchema, type ZodType } from 'zod';

// Type imports
import type { ToolDefinition } from '@model';

// Local file imports
import { BaseTool } from './base';

/** Convert a tool's Zod input schema into the JSON Schema `parameters` every `ToolDefinition` carries. */
export function toToolParameters(schema: ZodType): Record<string, unknown> {
  return toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'input',
  }) as Record<string, unknown>;
}

/**
 * Define a tool with type-safe schema and either a static or dynamic description.
 *
 * Use a function for description when the content depends on data that's loaded
 * asynchronously (e.g., agent registry) - the function is called lazily when
 * the tool definition is accessed.
 */
export function defineTool<T>(def: {
  name: string;
  /** Static description string or function for lazy evaluation */
  description: string | (() => string);
  schema: ZodType<T, T>;
  /**
   * Declare the tool side-effect-free and approval-free, allowing parallel
   * calls in one model response to execute concurrently (see ITool).
   */
  parallelSafe?: boolean;
  /** Execution behavior consumed by tool resolution and dispatch. */
  requiresApproval?: boolean;
  slow?: boolean;
  deferLogUntilApproval?: boolean;
  streamsOutput?: boolean;
}) {
  const getDescription = (): string =>
    typeof def.description === 'function' ? def.description() : def.description;

  const buildDefinition = (
    override?: Partial<ToolDefinition>,
  ): ToolDefinition => ({
    name: def.name,
    description: getDescription(),
    parameters: toToolParameters(def.schema),
    // Include original Zod schema for SDK-native conversions (OpenAI, Anthropic)
    zodSchema: def.schema,
    ...override,
  });

  abstract class GeneratedTool extends BaseTool<T> {
    readonly parallelSafe = def.parallelSafe;
    readonly requiresApproval = def.requiresApproval;
    readonly slow = def.slow;
    readonly deferLogUntilApproval = def.deferLogUntilApproval;
    readonly streamsOutput = def.streamsOutput;

    constructor(override?: Partial<ToolDefinition>) {
      super(buildDefinition(override), def.schema);
    }
  }

  return GeneratedTool;
}
