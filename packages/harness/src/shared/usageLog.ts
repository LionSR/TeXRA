import { Context, Effect, Layer } from 'effect';

import type { ModelOrigin } from '@texra-ai/llm';
import type { ConfigProvider } from '@shared/config/settings';
import {
  AGENT_SOURCE,
  type AgentSource,
  type UsageRoute,
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

/**
 * One entry of the usage log's wire: a body of the `log-usage-v2` edge
 * function, which is its boundary and decodes it
 * (`supabase/functions/log-usage-v2/usageBatch.ts`); this side only builds
 * it. Field names are the wire's, not `NormalizedUsage`'s.
 */
export interface UsageLogEntry {
  /** A UTC ISO 8601 date-time. */
  readonly timestamp: string;
  /** The catalog id, before any route's rewrite. */
  readonly model: string;
  /** Wire surface of the turn (`openai-responses`, `anthropic-messages`,
   *  ...), stored in the `provider` column. */
  readonly provider: ModelOrigin['protocol'];
  readonly agentName?: string;
  /** The route the call was billed through. */
  readonly usageRoute?: UsageRoute;
  /** The run id, stored as `stream_id`: the edge function's name for it. */
  readonly streamId?: string;
  /** Cache-miss input tokens; the cache reads are `cachedInputTokens`. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** What the call costs at the catalog's list prices, in USD, whatever
   *  the route billed: a plan's call is covered by its subscription. */
  readonly listCost: number;
  readonly responseTimeMs?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly extensionVersion?: string | undefined;
  readonly editorType?: string | undefined;
}

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
