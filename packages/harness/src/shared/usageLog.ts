import { Context, Effect, Layer, Schema, Struct } from 'effect';

import { TurnProtocolSchema } from '@texra-ai/llm';
import type { ConfigProvider } from '@platform/interfaces';
import {
  AGENT_SOURCE,
  UsageRouteSchema,
  type AgentSource,
} from '@shared/schemas';

/**
 * The agent name a usage entry may carry. Telemetry is metadata only, and a
 * user-authored (or plugin) agent's name can be any private string, so only a
 * bundled agent's id goes out; every other agent is the literal `custom`.
 */
export function usageAgentName(
  name: string,
  source: AgentSource | null | undefined,
): string {
  return source === AGENT_SOURCE.BUILT_IN ? name : 'custom';
}

const UsageLogMetadataSchema = Schema.Struct({
  model: Schema.String,
  /** Wire surface of the turn (`openai-responses`, `anthropic-messages`, ...).
   * The edge function stores it in the `provider` column; the column takes
   * protocol names under the same versioning rule as the rest of this wire. */
  provider: TurnProtocolSchema,
  agentName: Schema.optional(Schema.String),
  /** Canonical route used to account for API-key/subscription usage. */
  usageRoute: Schema.optional(UsageRouteSchema),
  /** Wire key of the usage-log edge function (`supabase/functions/log-usage-v2`), which
   * stores it as `stream_id`; the value is the run id. External contract, versioned
   * with the edge function, not with the run vocabulary. */
  streamId: Schema.optional(Schema.String),
});

/**
 * Field names here intentionally follow this wire schema, not
 * `NormalizedUsage`'s — this is the persisted log contract, so
 * renaming fields isn't free.
 */
const UsageLogStatsSchema = Schema.Struct({
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  responseTimeMs: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  cachedInputTokens: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  reasoningTokens: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});

const UsageLogEntrySchema = UsageLogMetadataSchema.mapFields(
  Struct.assign(UsageLogStatsSchema.fields),
).mapFields(
  Struct.assign({
    timestamp:
      Schema.String /* TODO(effect-schema): z.iso.datetime; was `z.iso.datetime()` */,
    extensionVersion: Schema.optional(Schema.String),
    editorType: Schema.optional(Schema.String),
  }),
);

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
>()('@texra-ai/harness/UsageLog') {
  static readonly disabled = Layer.succeed(UsageLog)({
    log: () => Effect.void,
  });
}
