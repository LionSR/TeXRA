import { Schema } from 'effect';

import type { ToolCard } from './progressView/data';

/**
 * Zod schema for validating tool definition structure.
 * Single source of truth - type is derived via z.infer<>.
 *
 * Note: zodSchema uses z.custom<ZodType>() because ZodType instances can't be
 * validated by Zod itself. This field is runtime-only (added by defineTool(),
 * not present in YAML configs) but acknowledged in the schema for type safety.
 *
 * Uses z.looseObject() to allow forward compatibility with future runtime
 * fields without breaking validation when tools flow through AgentSettingSchema.
 */
export const ToolDefinitionSchema = Schema.StructWithRest(
  Schema.Struct({
    /** Name of the tool or function */
    name: Schema.String,
    /** Optional description for the model */
    description: Schema.optional(Schema.String),
    /** Parameter schema (JSON Schema format) */
    parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /** Runtime-only: original Zod schema for SDK-native conversion */
    zodSchema: Schema.optional(
      Schema.declare<ZodType>((_u): _u is ZodType => true),
    ),
    /**
     * What a script's call of the tool resolves to, as a TypeScript type, when
     * it is not `ToolOutput` (`{ output, summary }`): a tool whose result
     * carries a `value` declares that value's type here.
     */
    scriptReturns: Schema.optional(Schema.String),
    /**
     * Runtime-only, like `zodSchema`: the card a call states from its input
     * (`ToolUseLog.card`), in place of the sections the transcript derives
     * from the tool's name. What a plugin's tool shows that the harness
     * knows nothing of.
     */
    card: Schema.optional(
      Schema.declare<(input: unknown) => ToolCard | undefined>(
        (_u): _u is (input: unknown) => ToolCard | undefined => true,
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Tool definition type - derived from schema */
export type ToolDefinition = typeof ToolDefinitionSchema.Type;
