import { Context, Effect, Layer, Schema } from 'effect';

import { TurnProtocolSchema } from '@texra-ai/llm';
import type { ConfigProvider } from '@shared/config/settings';
import {
  UsageRouteSchema,
  NonNegativeIntSchema,
  programOf,
  programOrigin,
  type AgentConfig,
} from '@shared/schemas';

/**
 * The program name a usage entry may carry (`agentName`). Telemetry is
 * metadata only, and a run's label, an installed plugin's program name or
 * an agent's own program name can be any private string, so only the name
 * of a program a listed plugin registers goes out; a chat run, or any other
 * program's, carries none.
 */
export function usageAgentName(
  config: Pick<AgentConfig, 'script'>,
): string | undefined {
  const program = programOf(config);
  return program !== null && programOrigin(program.name) === 'listed'
    ? program.name
    : undefined;
}

const Count = NonNegativeIntSchema;

/**
 * One entry of the usage log's wire, a body of the `log-usage-v2` edge
 * function. The sender checks each entry against it before queueing, so
 * nothing goes out that the edge would reject. Field names are the wire's,
 * not `NormalizedUsage`'s.
 *
 * The edge function decodes the same entry, and the two must match: everything this schema accepts, that one accepts.
 * There the counts are non-negative ints, `listCost` a non-negative finite
 * number, `timestamp` a UTC ISO 8601 date-time and every string non-empty,
 * `provider` and `usageRoute` included.
 */
export const UsageLogEntrySchema = Schema.Struct({
  timestamp: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, {
      expected: 'a UTC ISO 8601 date-time',
    }),
  ),
  /** The catalog id, before any route's rewrite. */
  model: Schema.NonEmptyString,
  /** Wire surface of the turn (`openai-responses`, `anthropic-messages`,
   *  ...), stored in the `provider` column. */
  provider: TurnProtocolSchema,
  /** The listed program the call served (`usageAgentName`); absent for a
   *  chat run and a call outside any run's program. */
  agentName: Schema.optional(Schema.NonEmptyString),
  /** The route the call was billed through. */
  usageRoute: Schema.optional(UsageRouteSchema),
  /** The run id, stored as `stream_id`: the edge function's name for it. */
  streamId: Schema.optional(Schema.NonEmptyString),
  /** Cache-miss input tokens; the cache reads are `cachedInputTokens`. */
  inputTokens: Count,
  outputTokens: Count,
  /** What the call costs at the catalog's list prices, in USD, whatever
   *  the route billed: a plan's call is covered by its subscription. A
   *  model the catalog lists only for a plan (Kimi Code's
   *  `kimi-for-coding*`) has no list price, so its calls report 0. */
  listCost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  responseTimeMs: Schema.optional(Count),
  cachedInputTokens: Schema.optional(Count),
  reasoningTokens: Schema.optional(Count),
  extensionVersion: Schema.optional(Schema.NonEmptyString),
  editorType: Schema.optional(Schema.NonEmptyString),
});

export type UsageLogEntry = typeof UsageLogEntrySchema.Type;

/** The process-owned producer; telemetry supplies its scoped sender implementation. */
export class UsageLog extends Context.Service<
  UsageLog,
  {
    readonly log: (
      entry: Omit<
        UsageLogEntry,
        'timestamp' | 'extensionVersion' | 'editorType'
      >,
      config: ConfigProvider,
      /** The environment the recording run saw (its project's `.env`
       *  over the process's), whose opt-out variables also gate it;
       *  absent, the process's own. */
      env?: Readonly<Record<string, string | undefined>>,
    ) => Effect.Effect<void>;
  }
>()('@texra-ai/worldline/UsageLog') {
  static readonly disabled = Layer.succeed(UsageLog)({
    log: () => Effect.void,
  });
}
