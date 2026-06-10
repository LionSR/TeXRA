/**
 * Log Usage Edge Function - Records API usage for analytics and rate limiting.
 *
 * Receives batched usage entries from the TeXRA extension and stores them
 * via the public.usage_logs_upsert RPC, which aggregates per-stream so the
 * table grows by run rather than by round.
 *
 * Authentication: JWT token in Authorization header (Bearer {jwt})
 *
 * Endpoints:
 * - POST /log-usage - Log a batch of usage entries
 *
 * Database Requirements:
 * - Table: usage_logs with unique index on (user_id, stream_id) where stream_id IS NOT NULL
 * - RPC: usage_logs_upsert (service role only)
 */

import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { authenticateJwt, bearerToken } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { versionedJsonResponse } from '../_shared/responses.ts';

// =============================================================================
// Constants
// =============================================================================

const LOG_USAGE_VERSION = '1.2.0';

// =============================================================================
// Schemas
// =============================================================================

// Invalid optional fields are dropped (`.catch(undefined)`) rather than
// rejecting the whole entry; invalid required fields reject the entry.
const UsageLogEntrySchema = z.object({
  timestamp: z.string(),
  model: z.string(),
  provider: z.string(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  agentName: z.string().optional().catch(undefined),
  agentCategory: z.enum(['workflow', 'toolUse']).optional().catch(undefined),
  isMultipleOutput: z.boolean().optional().catch(undefined),
  responseTimeMs: z.number().optional().catch(undefined),
  cachedInputTokens: z.number().optional().catch(undefined),
  reasoningTokens: z.number().optional().catch(undefined),
  usedRelay: z.boolean().optional().catch(undefined),
  streamId: z.string().optional().catch(undefined),
  extensionVersion: z.string().optional().catch(undefined),
  editorType: z.string().optional().catch(undefined),
});

const UsageBatchSchema = z.object({
  entries: z.array(z.unknown()),
  batchId: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(
  req: Request,
  body: Record<string, unknown>,
  status: number,
): Response {
  return versionedJsonResponse(req, LOG_USAGE_VERSION, body, status);
}

function errorResponse(req: Request, error: string, status: number): Response {
  return jsonResponse(req, { success: false, accepted: 0, error }, status);
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

  // Check environment on each request (allows for hot-reload)
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    return errorResponse(req, 'Server configuration error', 500);
  }

  try {
    // 1. Extract and validate JWT
    const jwtToken = bearerToken(req);
    if (!jwtToken) {
      return errorResponse(req, 'Missing authorization token', 401);
    }

    // 2. Validate user with Supabase
    const auth = await authenticateJwt(jwtToken);
    if (!auth) {
      return errorResponse(req, 'Invalid or expired token', 401);
    }
    const { user } = auth;

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
    const validEntries: z.infer<typeof UsageLogEntrySchema>[] = [];
    for (const entry of batch.entries) {
      const result = UsageLogEntrySchema.safeParse(entry);
      if (result.success) validEntries.push(result.data);
    }

    if (validEntries.length === 0) {
      return jsonResponse(
        req,
        { success: true, accepted: 0, message: 'No valid entries in batch' },
        200,
      );
    }

    // 6. Insert entries into database (service role for write access)
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Check for duplicate batch (idempotency for client retries).
    // After per-stream compaction the canonical row keeps only one batch_id
    // out of the inputs that produced it, so this is best-effort: it catches
    // the common case of an immediate retry of an in-flight request.
    const { data: existingBatch } = await adminClient
      .from('usage_logs')
      .select('id')
      .eq('user_id', user.id)
      .eq('batch_id', batch.batchId)
      .limit(1);

    if (existingBatch && existingBatch.length > 0) {
      return jsonResponse(
        req,
        {
          success: true,
          accepted: validEntries.length,
          message: 'Batch already processed (deduplicated)',
        },
        200,
      );
    }

    const rows = validEntries.map((entry) => ({
      user_id: user.id,
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
      batch_id: batch.batchId,
    }));

    // Server-side aggregation: rows with the same (user_id, stream_id) update
    // the canonical row instead of producing per-round duplicates.
    const { error: rpcError } = await adminClient.rpc('usage_logs_upsert', {
      p_rows: rows,
    });

    if (rpcError) {
      console.error('[LOG_USAGE] Upsert error:', rpcError.message);
      return errorResponse(req, 'Failed to store usage logs', 500);
    }

    // 7. Return success response
    return jsonResponse(
      req,
      { success: true, accepted: validEntries.length },
      200,
    );
  } catch (error) {
    console.error('[LOG_USAGE] Unexpected error:', error);
    return errorResponse(req, 'Internal server error', 500);
  }
});
