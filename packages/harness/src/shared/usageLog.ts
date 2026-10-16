import { Context, Layer } from 'effect';
import { z } from 'zod';

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

const UsageLogMetadataSchema = z.object({
  model: z.string(),
  /** Wire surface of the turn (`openai-responses`, `anthropic-messages`, ...).
   * The edge function stores it in the `provider` column; the column takes
   * protocol names under the same versioning rule as the rest of this wire. */
  provider: TurnProtocolSchema,
  agentName: z.string().optional(),
  /** Canonical route used to account for API-key/subscription usage. */
  usageRoute: UsageRouteSchema.optional(),
  /** Wire key of the usage-log edge function (`supabase/functions/log-usage-v2`), which
   * stores it as `stream_id`; the value is the run id. External contract, versioned
   * with the edge function, not with the run vocabulary. */
  streamId: z.string().optional(),
});

/**
 * Field names here intentionally follow this wire schema, not
 * `NormalizedUsage`'s — this is the persisted log contract, so
 * renaming fields isn't free.
 */
const UsageLogStatsSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cost: z.number().nonnegative(),
  responseTimeMs: z.number().nonnegative().optional(),
  cachedInputTokens: z.int().nonnegative().optional(),
  reasoningTokens: z.int().nonnegative().optional(),
});

const UsageLogEntrySchema = UsageLogMetadataSchema.extend(
  UsageLogStatsSchema.shape,
).extend({
  timestamp: z.iso.datetime(),
  extensionVersion: z.string().optional(),
  editorType: z.string().optional(),
});

export type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

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
    ) => void;
  }
>()('@texra/UsageLog') {
  static readonly disabled = Layer.succeed(UsageLog)({ log: () => {} });
}
