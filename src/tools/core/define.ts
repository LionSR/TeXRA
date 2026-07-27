// Third-party imports
import { toJSONSchema, type ZodType } from 'zod';

// Type imports
import type { ToolDefinition } from '@model';

// Local imports - shared
import { TOOL_JSON_SCHEMA_OPTIONS } from '@shared/tools/toolJsonSchema';

// Local file imports
import { BaseTool } from './base';

/** Convert a tool's Zod input schema into the JSON Schema `parameters` every `ToolDefinition` carries. */
export function toToolParameters(schema: ZodType): Record<string, unknown> {
  return toJSONSchema(schema, TOOL_JSON_SCHEMA_OPTIONS) as Record<
    string,
    unknown
  >;
}

/**
 * The abstract class `defineTool` hands back: a `BaseTool<T>` carrying the
 * declared execution flags, constructible only through a subclass that
 * implements `execute`.
 *
 * Spelling this out is what keeps `defineTool`'s return type *nameable*.
 * Without it the return type is an anonymous class expression, and every
 * `class X extends defineTool(...)` becomes undeclarable — TypeScript emits
 * `TS4094: Property 'execute' of exported anonymous class type may not be
 * private or protected` for each one, because a `.d.ts` has no syntax for a
 * protected member on an anonymous class type. Naming the type sidesteps that
 * without widening `BaseTool.execute` to public.
 */
export type DefinedToolClass<T> = abstract new (
  override?: Partial<ToolDefinition>,
) => BaseTool<T> & {
  readonly parallelSafe: boolean | undefined;
  readonly requiresApproval: boolean | undefined;
  readonly slow: boolean | undefined;
  readonly deferLogUntilApproval: boolean | undefined;
  readonly streamsOutput: boolean | undefined;
};

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
}): DefinedToolClass<T> {
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
