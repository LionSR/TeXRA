/**
 * Log Usage Edge Function - Records API usage for analytics and rate limiting.
 *
 * Receives batched usage entries from the TeXRA extension and stores them
 * via service-role RPCs, which aggregate per-stream so the tables grow by run
 * rather than by round. ChatGPT-subscription usage is kept in a separate table
 * from paid relay/API-key usage.
 *
 * Authentication: JWT token in Authorization header (Bearer {jwt}), or a
 * CI relay token minted by `texra setup-token` (prefix `texra_relay_`)
 *
 * Endpoints:
 * - POST /log-usage - Log a batch of usage entries
 *
 * Response contract:
 * - Complete writes return success with the exact accepted entry count.
 * - Invalid batches are rejected atomically over HTTP 200 with
 *   `success: false`, `accepted: 0`, and `retryable: false`; HTTP 200 lets
 *   clients predating the retry marker read the body during rolling deploys.
 * - Malformed JSON uses the same permanent-rejection body with HTTP 400.
 * - Authentication and operational failures omit the permanent-rejection
 *   marker so clients retain and retry the original batch identifier.
 *
 * Database Requirements:
 * - Tables: usage_logs, subscription_usage_logs
 * - RPCs: usage_logs_upsert, subscription_usage_logs_upsert (service role only)
 */

import { createClient } from '@supabase/supabase-js';
import { bearerToken } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { resolveRelayCredential } from '../_shared/relayCiToken.ts';
import { versionedJsonResponse } from '../_shared/responses.ts';
import { UsageBatchSchema, type UsageLogEntry } from './usageValidation.ts';

// =============================================================================
// Constants
// =============================================================================

const LOG_USAGE_VERSION = '1.6.0';

const UsageDestinations = {
  paid: {
    table: 'usage_logs',
    rpc: 'usage_logs_upsert',
    accepts: (entry: UsageLogEntry) =>
      entry.usageRoute !== 'chatgpt-subscription',
    toRows: toDbRows,
  },
  subscription: {
    table: 'subscription_usage_logs',
    rpc: 'subscription_usage_logs_upsert',
    accepts: (entry: UsageLogEntry) =>
      entry.usageRoute === 'chatgpt-subscription',
    toRows: (
      userId: string,
      batchId: string,
      entries: readonly UsageLogEntry[],
    ) =>
      toDbRows(userId, batchId, entries).map((row, index) => ({
        ...row,
        source: entries[index].subscriptionSource ?? 'chatgpt',
      })),
  },
} as const;

type UsageDestination =
  (typeof UsageDestinations)[keyof typeof UsageDestinations];
const usageDestinations = Object.values(UsageDestinations);

// =============================================================================
// Helpers
// =============================================================================

function successResponse(
  req: Request,
  accepted: number,
  message?: string,
): Response {
  return versionedJsonResponse(
    req,
    LOG_USAGE_VERSION,
    {
      success: true,
      accepted,
      ...(message ? { message } : {}),
    },
    200,
  );
}

function errorResponse(
  req: Request,
  error: string,
  status: number,
  options?: { retryable?: boolean },
): Response {
  return versionedJsonResponse(
    req,
    LOG_USAGE_VERSION,
    {
      success: false,
      accepted: 0,
      error,
      ...(options?.retryable === undefined
        ? {}
        : { retryable: options.retryable }),
    },
    status,
  );
}

function toDbRows(
  userId: string,
  batchId: string,
  entries: readonly UsageLogEntry[],
) {
  return entries.map((entry) => ({
    user_id: userId,
    logged_at: entry.timestamp,
    model: entry.model,
    provider: entry.provider,
    agent_name: entry.agentName ?? null,
    agent_category: entry.agentCategory ?? null,
    is_multiple_output: entry.isMultipleOutput ?? null,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    cost: entry.cost,
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

async function batchExists(
  destination: UsageDestination,
  userId: string,
  batchId: string,
): Promise<boolean> {
  const { data: existingBatch, error } = await adminClient!
    .from(destination.table)
    .select('id')
    .eq('user_id', userId)
    .eq('batch_id', batchId)
    .limit(1);
  if (error) {
    throw new Error(
      `Failed to check ${destination.table} batch deduplication: ${error.message}`,
    );
  }
  return (existingBatch?.length ?? 0) > 0;
}

async function upsertUsageRows(
  destination: UsageDestination,
  rows: ReturnType<typeof toDbRows>,
): Promise<string | undefined> {
  if (rows.length === 0) return undefined;

  const { error: rpcError } = await adminClient!.rpc(destination.rpc, {
    p_rows: rows,
  });
  return rpcError?.message;
}

// =============================================================================
// Environment Validation (fail fast)
// =============================================================================

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
  console.error('[LOG_USAGE] Missing required environment variables');
}

// Service-role client for writes (env is fixed at cold start; no per-request state)
const adminClient =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

// =============================================================================
// Request Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  // Handle CORS
  const response = handleCors(req);
  if (response) return response;

  // Only accept POST requests
  if (req.method !== 'POST') {
    return errorResponse(req, 'Method not allowed', 405);
  }

  // Module-level init only logs, so requests must get an explicit 500 here
  // rather than crashing on a null dereference deeper in the handler.
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey || !adminClient) {
    return errorResponse(req, 'Server configuration error', 500);
  }

  try {
    // 1. Extract and validate the credential
    const jwtToken = bearerToken(req);
    if (!jwtToken) {
      return errorResponse(req, 'Missing authorization token', 401);
    }

    // 2. Validate user with Supabase. CI relay tokens (texra setup-token)
    // are accepted too so headless pipeline usage still feeds the spending
    // accounting the relay enforces.
    const credential = await resolveRelayCredential(jwtToken, adminClient);
    if (!credential.ok) {
      return errorResponse(req, credential.message, credential.status);
    }
    const userId = credential.userId;

    // 3. Parse request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(req, 'Invalid JSON body', 400, {
        retryable: false,
      });
    }

    // 4. Validate the complete batch before any destination write.
    const batchResult = UsageBatchSchema.safeParse(body);
    if (!batchResult.success) {
      // Keep the application-level rejection on HTTP 200 during the rolling
      // client transition. Older clients let ky throw before reading 4xx
      // bodies, which would pin this permanently invalid batch at the head of
      // their retry queue. They already understand success:false on 2xx.
      return errorResponse(req, 'Invalid batch format or entry data', 200, {
        retryable: false,
      });
    }
    const batch = batchResult.data;

    const entries = batch.entries;

    // 5. Check for duplicate batch (idempotency for client retries).
    // After per-stream compaction the canonical row keeps only one batch_id
    // out of the inputs that produced it, so this is best-effort: it catches
    // the common case of an immediate retry of an in-flight request. Each
    // destination is checked separately so a retry after a partial write can
    // still fill the missing table.
    const destinationRows = await Promise.all(
      usageDestinations.map(async (destination) => {
        const destinationEntries = entries.filter(destination.accepts);
        const rows =
          destinationEntries.length === 0 ||
          (await batchExists(destination, userId, batch.batchId))
            ? []
            : destination.toRows(userId, batch.batchId, destinationEntries);
        return { destination, rows };
      }),
    );

    if (destinationRows.every(({ rows }) => rows.length === 0)) {
      return successResponse(
        req,
        entries.length,
        'Batch already processed (deduplicated)',
      );
    }

    // Server-side aggregation: rows with the same (user_id, stream_id) update
    // the canonical row instead of producing per-round duplicates.
    const upsertErrors = (
      await Promise.all(
        destinationRows.map(({ destination, rows }) =>
          upsertUsageRows(destination, rows),
        ),
      )
    ).filter((message): message is string => message != null);

    if (upsertErrors.length > 0) {
      console.error('[LOG_USAGE] Upsert error:', upsertErrors.join('; '));
      return errorResponse(req, 'Failed to store usage logs', 500);
    }

    // 6. Return success response
    return successResponse(req, entries.length);
  } catch (error) {
    console.error('[LOG_USAGE] Unexpected error:', error);
    return errorResponse(req, 'Internal server error', 500);
  }
});
