/**
 * Legacy store for released clients: rows owned by a signed-in user, written
 * through service-role RPCs that aggregate per-stream so the tables grow by
 * run rather than by round. Subscription-backed usage is kept in a separate
 * table from paid API-key usage.
 *
 * Database Requirements:
 * - Tables: usage_logs, subscription_usage_logs
 * - RPCs: usage_logs_upsert, subscription_usage_logs_upsert (service role only)
 */

import { adminClient } from '../_shared/edgeClients.ts';
import { storedCost } from '../_shared/equivalentCost.ts';
import {
  subscriptionSourceForUsage,
  type UsageBatch,
  type UsageLogEntry,
} from '../_shared/usageValidation.ts';

function toDbRows(
  userId: string,
  batchId: string,
  entries: readonly UsageLogEntry[],
) {
  return entries.map((entry) => ({
    ...(subscriptionSourceForUsage(entry) && {
      source: subscriptionSourceForUsage(entry),
    }),
    user_id: userId,
    logged_at: entry.timestamp,
    model: entry.model,
    provider: entry.provider,
    agent_name: entry.agentName ?? null,
    agent_category: entry.agentCategory ?? null,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    cost: storedCost(entry),
    response_time_ms: entry.responseTimeMs ?? null,
    cached_input_tokens: entry.cachedInputTokens ?? null,
    reasoning_tokens: entry.reasoningTokens ?? null,
    used_relay: entry.usedRelay ?? false,
    stream_id: entry.streamId ?? null,
    extension_version: entry.extensionVersion ?? null,
    editor_type: entry.editorType ?? null,
    batch_id: batchId,
  }));
}

const destinations = [
  {
    table: 'usage_logs',
    rpc: 'usage_logs_upsert',
    accepts: (entry: UsageLogEntry) =>
      subscriptionSourceForUsage(entry) === undefined,
  },
  {
    table: 'subscription_usage_logs',
    rpc: 'subscription_usage_logs_upsert',
    accepts: (entry: UsageLogEntry) =>
      subscriptionSourceForUsage(entry) !== undefined,
  },
] as const;

/**
 * Best-effort batch dedup: after per-stream compaction the canonical row keeps
 * only one batch_id, so this catches an immediate retry. Each destination is
 * checked separately so a retry after a partial write can fill the missing
 * table. Returns false when nothing was left to write.
 */
export async function storeForUser(
  userId: string,
  batch: UsageBatch,
): Promise<boolean> {
  const writes = await Promise.all(
    destinations.map(async (destination) => {
      const entries = batch.entries.filter(destination.accepts);
      if (entries.length === 0) return null;
      const { data, error } = await adminClient!
        .from(destination.table)
        .select('id')
        .eq('user_id', userId)
        .eq('batch_id', batch.batchId)
        .limit(1);
      if (error) {
        throw new Error(
          `Failed to check ${destination.table} batch deduplication: ${error.message}`,
        );
      }
      return data.length > 0
        ? null
        : {
            rpc: destination.rpc,
            rows: toDbRows(userId, batch.batchId, entries),
          };
    }),
  );
  const pending = writes.filter((write) => write !== null);
  const errors = (
    await Promise.all(
      pending.map(async ({ rpc, rows }) => {
        const { error } = await adminClient!.rpc(rpc, { p_rows: rows });
        return error?.message;
      }),
    )
  ).filter((message) => message != null);
  if (errors.length > 0) {
    throw new Error(`Failed to store usage logs: ${errors.join('; ')}`);
  }
  return pending.length > 0;
}
