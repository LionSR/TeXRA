/**
 * Store for anonymous installs: an append-only event log, one row per entry
 * (the client sends one entry per model call). A retried batch conflicts on
 * (install_id, batch_id, entry_index) and inserts nothing.
 *
 * Database Requirements: table install_usage_logs, written by the service
 * role only (docs/supabase/install-usage-logs.sql).
 */

import { adminClient } from '../_shared/edgeClients.ts';
import { storedCost } from '../_shared/equivalentCost.ts';
import type { UsageBatch } from '../_shared/usageValidation.ts';

/** Returns false when the batch was already stored. */
export async function storeForInstall(
  installId: string,
  { batchId, entries }: UsageBatch,
): Promise<boolean> {
  const { count, error } = await adminClient!.from('install_usage_logs').upsert(
    entries.map((entry, index) => ({
      install_id: installId,
      batch_id: batchId,
      entry_index: index,
      logged_at: entry.timestamp,
      model: entry.model,
      provider: entry.provider,
      agent_name: entry.agentName ?? null,
      agent_category: entry.agentCategory ?? null,
      usage_route: entry.usageRoute ?? null,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cached_input_tokens: entry.cachedInputTokens ?? null,
      reasoning_tokens: entry.reasoningTokens ?? null,
      cost: storedCost(entry),
      response_time_ms: entry.responseTimeMs ?? null,
      stream_id: entry.streamId ?? null,
      extension_version: entry.extensionVersion ?? null,
      editor_type: entry.editorType ?? null,
    })),
    {
      onConflict: 'install_id,batch_id,entry_index',
      ignoreDuplicates: true,
      count: 'exact',
    },
  );
  if (error) {
    throw new Error(`Failed to store usage logs: ${error.message}`);
  }
  return count !== 0;
}
