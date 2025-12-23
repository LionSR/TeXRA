/**
 * Log Usage Edge Function - Records API usage for analytics and rate limiting.
 *
 * Receives batched usage entries from the TeXRA extension and stores them
 * in the usage_logs table. Also returns quota information for future rate limiting.
 *
 * Authentication: JWT token in Authorization header (Bearer {jwt})
 *
 * Endpoints:
 * - POST /log-usage - Log a batch of usage entries
 * - GET /log-usage/stats - Get usage statistics for current user (future)
 *
 * Database table: usage_logs
 * - id: UUID primary key
 * - user_id: Foreign key to auth.users
 * - timestamp: When the API call occurred
 * - model: Model identifier
 * - provider: API provider
 * - agent_name: Agent that made the request
 * - input_tokens: Number of input tokens
 * - output_tokens: Number of output tokens
 * - cost: Cost in USD
 * - response_time_ms: Response time
 * - cached_input_tokens: Tokens from cache
 * - reasoning_tokens: Tokens for reasoning
 * - used_relay: Whether server-side keys were used
 * - stream_id: Session identifier
 * - extension_version: Client version
 * - batch_id: For deduplication
 * - created_at: Server timestamp
 */

// Version for debugging deployments
const LOG_USAGE_VERSION = '1.0.0';

import { createClient } from 'jsr:@supabase/supabase-js@2';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/**
 * Usage log entry schema (matches UsageLogEntrySchema in extension).
 * Validated server-side for safety.
 */
interface UsageLogEntry {
  timestamp: string;
  model: string;
  provider: string;
  agentName?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  responseTimeMs?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  usedRelay?: boolean;
  streamId?: string;
  extensionVersion?: string;
}

interface UsageLogBatch {
  entries: UsageLogEntry[];
  batchId: string;
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

  return {
    timestamp: e.timestamp,
    model: e.model,
    provider: e.provider,
    agentName: typeof e.agentName === 'string' ? e.agentName : undefined,
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
  };
}

/**
 * Get user's usage quota (for future rate limiting).
 * Currently returns null - implement when rate limits are needed.
 */
async function getUserQuota(
  _supabase: ReturnType<typeof createClient>,
  _userId: string,
): Promise<{
  dailyLimit?: number;
  dailyUsed?: number;
  dailyRemaining?: number;
  monthlyLimit?: number;
  monthlyUsed?: number;
  isLimited?: boolean;
  resetsAt?: string;
} | null> {
  // TODO: Implement quota tracking when rate limits are needed
  // This will query the usage_logs table to calculate daily/monthly usage
  // and compare against limits defined in the profiles table
  return null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({
        _version: LOG_USAGE_VERSION,
        success: false,
        accepted: 0,
        error: 'Method not allowed',
      }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  try {
    // 1. Extract and validate JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: false,
          accepted: 0,
          error: 'Missing authorization token',
        }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const jwtToken = authHeader.substring(7);

    // 2. Validate user with Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('[LOG_USAGE] Missing Supabase environment variables');
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: false,
          accepted: 0,
          error: 'Server configuration error',
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // Create client with user's JWT for authentication
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwtToken}` } },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: false,
          accepted: 0,
          error: 'Invalid or expired token',
        }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 3. Parse request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: false,
          accepted: 0,
          error: 'Invalid JSON body',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 4. Validate batch structure
    if (!body || typeof body !== 'object') {
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: false,
          accepted: 0,
          error: 'Invalid request body',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const batch = body as Record<string, unknown>;
    if (!Array.isArray(batch.entries) || typeof batch.batchId !== 'string') {
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: false,
          accepted: 0,
          error: 'Invalid batch format: expected { entries: [], batchId: string }',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
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
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: true,
          accepted: 0,
          message: 'No valid entries in batch',
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 6. Insert entries into database
    // Use service role key for write access (RLS would require policy changes)
    const adminClient = supabaseServiceKey
      ? createClient(supabaseUrl, supabaseServiceKey)
      : userClient;

    // Check for duplicate batch (idempotency for retries)
    const { data: existingBatch } = await adminClient
      .from('usage_logs')
      .select('id')
      .eq('user_id', user.id)
      .eq('batch_id', batch.batchId)
      .limit(1);

    if (existingBatch && existingBatch.length > 0) {
      // Batch already processed - return success to prevent client retries
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: true,
          accepted: validEntries.length,
          message: 'Batch already processed (deduplicated)',
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const rows = validEntries.map((entry) => ({
      user_id: user.id,
      timestamp: entry.timestamp,
      model: entry.model,
      provider: entry.provider,
      agent_name: entry.agentName,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cost: entry.cost,
      response_time_ms: entry.responseTimeMs,
      cached_input_tokens: entry.cachedInputTokens,
      reasoning_tokens: entry.reasoningTokens,
      used_relay: entry.usedRelay,
      stream_id: entry.streamId,
      extension_version: entry.extensionVersion,
      batch_id: batch.batchId,
    }));

    const { error: insertError } = await adminClient
      .from('usage_logs')
      .insert(rows);

    if (insertError) {
      console.error('[LOG_USAGE] Insert error:', insertError.message);
      return new Response(
        JSON.stringify({
          _version: LOG_USAGE_VERSION,
          success: false,
          accepted: 0,
          error: 'Failed to store usage logs',
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    // 7. Get quota information (for future rate limiting)
    const quota = await getUserQuota(adminClient, user.id);

    // 8. Return success response
    return new Response(
      JSON.stringify({
        _version: LOG_USAGE_VERSION,
        success: true,
        accepted: validEntries.length,
        quota,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    console.error('[LOG_USAGE] Unexpected error:', error);
    return new Response(
      JSON.stringify({
        _version: LOG_USAGE_VERSION,
        success: false,
        accepted: 0,
        error: 'Internal server error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
