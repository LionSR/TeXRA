import { Schema } from 'effect';

import type { ToolCard } from './progressView/data';

/**
 * The shape of a tool definition; the type is derived from it.
 *
 * `schema` is declared with `Schema.isSchema` because a schema instance is not
 * itself describable by a schema. The field is runtime-only (set by
 * `defineTool()`, never present in YAML configs) but acknowledged here for
 * type safety.
 *
 * Keeps unknown keys so future runtime fields do not break validation when
 * tools flow through an agent persona's `tools` (`PersonaSchema` in `agent.ts`).
 */
export const ToolDefinitionSchema = Schema.StructWithRest(
  Schema.Struct({
    /** Name of the tool or function */
    name: Schema.String,
    /** Optional description for the model */
    description: Schema.optional(Schema.String),
    /** Parameter schema (JSON Schema format) */
    parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /**
     * Runtime-only: the tool's input schema, from which the provider
     * converters derive JSON Schema per request.
     */
    schema: Schema.optionalKey(
      Schema.declare((u): u is Schema.Codec<unknown, unknown> =>
        Schema.isSchema(u),
      ),
    ),
    /**
     * What a script's call of the tool resolves to, as a TypeScript type, when
     * it is not `ToolOutput` (`{ output, summary }`): a tool whose result
     * carries a `value` declares that value's type here.
     */
    scriptReturns: Schema.optional(Schema.String),
    /**
     * Runtime-only, like `schema`: the card a call states from its input
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
