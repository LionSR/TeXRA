import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // User client: uses user's JWT for auth verification and RLS-protected queries
    // This ensures RLS policies on remote_agents table are enforced
    const userClient = createClient(supabaseUrl, serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Admin client: uses only SERVICE_ROLE_KEY for storage operations
    // This bypasses bucket policies (safe because we already verify access via RLS)
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Verify user with their JWT
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get agent name from request
    const { agentName } = await req.json();
    if (!agentName) {
      return new Response(JSON.stringify({ error: 'agentName required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch agent metadata using userClient (RLS enforces access control)
    // RLS policies check user permissions/whitelist - unauthorized users won't see the agent
    const { data: agent, error: agentError } = await userClient
      .from('remote_agents')
      .select('id, name, description, storage_path, visibility, agent_category')
      .eq('name', agentName)
      .single();

    if (agentError || !agent) {
      return new Response(
        JSON.stringify({
          error: 'Agent not found or access denied',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Fetch YAML from storage using adminClient (bypasses bucket policies)
    // Safe because access was already verified via RLS on remote_agents table
    const { data: fileData, error: storageError } = await adminClient.storage
      .from('agent-configs')
      .download(agent.storage_path);

    if (storageError || !fileData) {
      console.error('Storage error:', storageError);
      return new Response(
        JSON.stringify({
          error: 'Failed to load agent configuration',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Read file content (in memory only, never persisted)
    const yamlContent = await fileData.text();

    return new Response(
      JSON.stringify({
        config: yamlContent,
        name: agent.name,
        description: agent.description,
        visibility: agent.visibility, // string[] - array of groups
        agentCategory: agent.agent_category, // 'workflow' or 'toolUse'
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
