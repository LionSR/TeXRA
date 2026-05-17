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

import { createClient } from 'jsr:@supabase/supabase-js@2.104.1';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

// =============================================================================
// Constants
// =============================================================================

const LOG_USAGE_VERSION = '1.1.0';

// =============================================================================
// Types
// =============================================================================

interface UsageLogEntry {
  timestamp: string;
  model: string;
  provider: string;
  agentName?: string;
  agentCategory?: 'workflow' | 'toolUse';
  isMultipleOutput?: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  responseTimeMs?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  usedRelay?: boolean;
  streamId?: string;
  extensionVersion?: string;
  editorType?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(
  req: Request,
  body: Record<string, unknown>,
  status: number,
): Response {
  const corsHeaders = getCorsHeaders(req);
  return new Response(
    JSON.stringify({ _version: LOG_USAGE_VERSION, ...body }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
}

function errorResponse(req: Request, error: string, status: number): Response {
  return jsonResponse(req, { success: false, accepted: 0, error }, status);
}

/**
 * Validate a single usage entry.
 * Returns null if invalid, the entry if valid.
 */
function validateEntry(entry: unknown): UsageLogEntry | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const e = entry as Record<string, unknown>;

  // Required fields
  if (
    typeof e.timestamp !== 'string' ||
    typeof e.model !== 'string' ||
    typeof e.provider !== 'string' ||
    typeof e.inputTokens !== 'number' ||
    typeof e.outputTokens !== 'number' ||
    typeof e.cost !== 'number'
  ) {
    return null;
  }

  // Validate non-negative numbers
  if (e.inputTokens < 0 || e.outputTokens < 0 || e.cost < 0) {
    return null;
  }

  // Validate agentCategory enum
  const agentCategory =
    e.agentCategory === 'workflow' || e.agentCategory === 'toolUse'
      ? e.agentCategory
      : undefined;

  return {
    timestamp: e.timestamp,
    model: e.model,
    provider: e.provider,
    agentName: typeof e.agentName === 'string' ? e.agentName : undefined,
    agentCategory,
    isMultipleOutput:
      typeof e.isMultipleOutput === 'boolean' ? e.isMultipleOutput : undefined,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cost: e.cost,
    responseTimeMs:
      typeof e.responseTimeMs === 'number' ? e.responseTimeMs : undefined,
    cachedInputTokens:
      typeof e.cachedInputTokens === 'number' ? e.cachedInputTokens : undefined,
    reasoningTokens:
      typeof e.reasoningTokens === 'number' ? e.reasoningTokens : undefined,
    usedRelay: typeof e.usedRelay === 'boolean' ? e.usedRelay : undefined,
    streamId: typeof e.streamId === 'string' ? e.streamId : undefined,
    extensionVersion:
      typeof e.extensionVersion === 'string' ? e.extensionVersion : undefined,
    editorType: typeof e.editorType === 'string' ? e.editorType : undefined,
  };
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
  const { response } = handleCors(req);
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
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return errorResponse(req, 'Missing authorization token', 401);
    }

    const jwtToken = authHeader.substring(7);

    // 2. Validate user with Supabase
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwtToken}` } },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return errorResponse(req, 'Invalid or expired token', 401);
    }

    // 3. Parse request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(req, 'Invalid JSON body', 400);
    }

    // 4. Validate batch structure
    if (!body || typeof body !== 'object') {
      return errorResponse(req, 'Invalid request body', 400);
    }

    const batch = body as Record<string, unknown>;
    if (!Array.isArray(batch.entries) || typeof batch.batchId !== 'string') {
      return errorResponse(
        req,
        'Invalid batch format: expected { entries: [], batchId: string }',
        400,
      );
    }

    // 5. Validate and transform entries
    const validEntries: UsageLogEntry[] = [];
    for (const entry of batch.entries) {
      const validated = validateEntry(entry);
      if (validated) {
        validEntries.push(validated);
      }
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
