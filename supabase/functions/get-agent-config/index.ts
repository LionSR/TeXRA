/**
 * Get Agent Config Edge Function - Fetches remote agent configurations.
 *
 * Authentication: JWT token in Authorization header
 *
 * Endpoints:
 * - POST /get-agent-config - Fetch agent YAML config by name
 */

import { authenticateJwt, bearerToken } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
// The service-role client bypasses bucket policies for storage operations.
import {
  adminClient,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from '../_shared/edgeClients.ts';
import { errorResponse, jsonResponse } from '../_shared/responses.ts';

// =============================================================================
// Request Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  // Handle CORS
  const response = handleCors(req);
  if (response) return response;

  // Only accept POST
  if (req.method !== 'POST') {
    return errorResponse(req, 'Method not allowed', 405);
  }

  // Check environment
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !adminClient) {
    console.error('[GET_AGENT_CONFIG] Missing required environment variables');
    return errorResponse(req, 'Server configuration error', 500);
  }

  try {
    // 1. Extract and validate auth
    const jwtToken = bearerToken(req);
    if (!jwtToken) {
      return errorResponse(req, 'Unauthorized', 401);
    }

    // 2. Verify user; the returned client runs queries as the user (RLS applies)
    const auth = await authenticateJwt(jwtToken);
    if (!auth) {
      return errorResponse(req, 'Invalid token', 401);
    }
    const userClient = auth.client;

    // 3. Get agent name from request
    let body: { agentName?: string };
    try {
      body = await req.json();
    } catch {
      return errorResponse(req, 'Invalid JSON body', 400);
    }

    if (!body.agentName) {
      return errorResponse(req, 'agentName required', 400);
    }

    // 4. Fetch agent metadata (RLS enforces access control)
    // Description comes from YAML (parsed client-side), not DB
    const { data: agent, error: agentError } = await userClient
      .from('remote_agents')
      .select('id, name, storage_path, visibility, agent_category')
      .eq('name', body.agentName)
      .single();

    if (agentError || !agent) {
      return errorResponse(req, 'Agent not found or access denied', 404);
    }

    // 5. Fetch YAML from storage (admin client bypasses bucket policies)
    const { data: fileData, error: storageError } = await adminClient.storage
      .from('agent-configs')
      .download(agent.storage_path);

    if (storageError || !fileData) {
      console.error('[GET_AGENT_CONFIG] Storage error:', storageError);
      return errorResponse(req, 'Failed to load agent configuration', 500);
    }

    // 6. Return config (client parses YAML and extracts description)
    const yamlContent = await fileData.text();

    return jsonResponse(
      req,
      {
        config: yamlContent,
        name: agent.name,
        visibility: agent.visibility,
        agentCategory: agent.agent_category,
      },
      200,
    );
  } catch (err) {
    console.error('[GET_AGENT_CONFIG] Error:', err);
    return errorResponse(req, 'Internal server error', 500);
  }
});
