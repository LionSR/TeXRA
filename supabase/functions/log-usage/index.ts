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
 * Database Requirements:
 * - Tables: usage_logs, chatgpt_subscription_usage_logs
 * - RPCs: usage_logs_upsert, chatgpt_subscription_usage_logs_upsert (service role only)
 */

import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bearerToken } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { resolveRelayCredential } from '../_shared/relayCiToken.ts';
import { versionedJsonResponse } from '../_shared/responses.ts';

// =============================================================================
// Constants
// =============================================================================

const LOG_USAGE_VERSION = '1.4.0';

// =============================================================================
// Schemas
// =============================================================================

// Invalid optional fields are dropped (`.catch(undefined)`) rather than
// rejecting the whole entry; invalid required fields reject the entry.
const optionalString = z
  .string()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);
const optionalNonnegativeInt = z
  .int()
  .nonnegative()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);
const optionalNonnegativeNumber = z
  .number()
  .nonnegative()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);
const optionalBoolean = z
  .boolean()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);

const UsageLogEntrySchema = z.object({
  timestamp: z.iso.datetime(),
  model: z.string(),
  provider: z.string(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cost: z.number().nonnegative(),
  agentName: optionalString,
  agentCategory: z
    .enum(['workflow', 'toolUse'])
    .nullish()
    .catch(undefined)
    .transform((value) => value ?? undefined),
  isMultipleOutput: optionalBoolean,
  responseTimeMs: optionalNonnegativeNumber,
  cachedInputTokens: optionalNonnegativeInt,
  reasoningTokens: optionalNonnegativeInt,
  usedRelay: optionalBoolean,
  viaChatGptSubscription: z
    .boolean()
    .nullish()
    .catch(false)
    .transform((value) => value ?? false),
  streamId: optionalString,
  extensionVersion: optionalString,
  editorType: optionalString,
});

const UsageBatchSchema = z.object({
  entries: z.array(z.unknown()),
  batchId: z.uuid(),
});

type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

const UsageDestinations = {
  paid: {
    table: 'usage_logs',
    rpc: 'usage_logs_upsert',
  },
  chatgptSubscription: {
    table: 'chatgpt_subscription_usage_logs',
    rpc: 'chatgpt_subscription_usage_logs_upsert',
  },
} as const;

type UsageDestination =
  (typeof UsageDestinations)[keyof typeof UsageDestinations];

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

function errorResponse(req: Request, error: string, status: number): Response {
  return versionedJsonResponse(
    req,
    LOG_USAGE_VERSION,
    { success: false, accepted: 0, error },
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
  const { data: existingBatch } = await adminClient!
    .from(destination.table)
    .select('id')
    .eq('user_id', userId)
    .eq('batch_id', batchId)
    .limit(1);
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
      return errorResponse(req, 'Invalid JSON body', 400);
    }

    // 4. Validate batch structure
    const batchResult = UsageBatchSchema.safeParse(body);
    if (!batchResult.success) {
      return errorResponse(
        req,
        'Invalid batch format: expected { entries: [], batchId: string }',
        400,
      );
    }
    const batch = batchResult.data;

    // 5. Validate and transform entries
    const validEntries: UsageLogEntry[] = [];
    for (const entry of batch.entries) {
      const result = UsageLogEntrySchema.safeParse(entry);
      if (result.success) validEntries.push(result.data);
    }

    if (validEntries.length === 0) {
      return successResponse(req, 0, 'No valid entries in batch');
    }

    // 6. Split paid relay/API-key usage from ChatGPT-subscription usage.
    const paidEntries = validEntries.filter(
      (entry) => !entry.viaChatGptSubscription,
    );
    const chatgptSubscriptionEntries = validEntries.filter(
      (entry) => entry.viaChatGptSubscription,
    );

    // 7. Check for duplicate batch (idempotency for client retries).
    // After per-stream compaction the canonical row keeps only one batch_id
    // out of the inputs that produced it, so this is best-effort: it catches
    // the common case of an immediate retry of an in-flight request. Each
    // destination is checked separately so a retry after a partial write can
    // still fill the missing table.
    const paidRows = (await batchExists(
      UsageDestinations.paid,
      userId,
      batch.batchId,
    ))
      ? []
      : toDbRows(userId, batch.batchId, paidEntries);
    const chatgptSubscriptionRows = (await batchExists(
      UsageDestinations.chatgptSubscription,
      userId,
      batch.batchId,
    ))
      ? []
      : toDbRows(userId, batch.batchId, chatgptSubscriptionEntries);

    if (paidRows.length === 0 && chatgptSubscriptionRows.length === 0) {
      return successResponse(
        req,
        validEntries.length,
        'Batch already processed (deduplicated)',
      );
    }

    // Server-side aggregation: rows with the same (user_id, stream_id) update
    // the canonical row instead of producing per-round duplicates.
    const upsertErrors = (
      await Promise.all([
        upsertUsageRows(UsageDestinations.paid, paidRows),
        upsertUsageRows(
          UsageDestinations.chatgptSubscription,
          chatgptSubscriptionRows,
        ),
      ])
    ).filter((message): message is string => message != null);

    if (upsertErrors.length > 0) {
      console.error('[LOG_USAGE] Upsert error:', upsertErrors.join('; '));
      return errorResponse(req, 'Failed to store usage logs', 500);
    }

    // 8. Return success response
    return successResponse(req, validEntries.length);
  } catch (error) {
    console.error('[LOG_USAGE] Unexpected error:', error);
    return errorResponse(req, 'Internal server error', 500);
  }
});
