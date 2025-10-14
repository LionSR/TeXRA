// Supabase Edge Function: execute-remote-agent
//
// This placeholder illustrates how TeXRA's remote execution endpoint should be
// structured. The function receives a signed Supabase access token from the
// extension and a proxy session token that authorises downstream model calls.
//
// The implementation intentionally avoids reading or writing prompts to disk.
// Instead, decrypted prompts are streamed directly into the model runtime and
// discarded once the response is returned to the extension.
//
// To deploy, copy this file into your Supabase project and replace the
// placeholder sections with your actual execution pipeline.
import type {
  Serve,
  RequestHandler,
} from 'https://esm.sh/@supabase/functions@2.4.1';

interface RemoteAgentRequest {
  agent: string;
  config: Record<string, unknown>;
  proxyToken?: string;
  proxySessionId?: string;
  timestamp: string;
}

interface RemoteAgentResponse {
  logs: Array<{ level: 'debug' | 'info' | 'warn' | 'error'; message: string }>;
  status: string;
  output?: string;
  usage?: Record<string, unknown>;
  error?: string;
}

const serve: Serve = async (req) => {
  const headers = new Headers({ 'Content-Type': 'application/json' });

  try {
    const payload = (await req.json()) as RemoteAgentRequest;
    const { agent, config, proxyToken, proxySessionId } = payload;

    if (!agent) {
      return new Response(
        JSON.stringify({ error: 'Agent identifier missing' }),
        { headers, status: 400 },
      );
    }

    // TODO: authenticate the Supabase JWT and ensure the account is authorised
    // to run the requested agent.

    // TODO: decrypt the agent prompt in-memory and stream it to the model.
    // Never persist decrypted prompts to disk.

    // TODO: forward the request to the TeXRA proxy or provider using the
    // supplied proxyToken. The proxy can mint a short-lived credential for the
    // upstream provider to ensure isolation per session.

    const response: RemoteAgentResponse = {
      logs: [
        { level: 'info', message: `Executing remote agent ${agent}` },
        {
          level: 'debug',
          message: `Config snapshot: ${JSON.stringify(config)}`,
        },
      ],
      status: 'queued',
    };

    // TODO: replace the stub response with the actual model output and usage.

    return new Response(JSON.stringify(response), { headers, status: 200 });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
      { headers, status: 500 },
    );
  }
};

export const handler: RequestHandler = serve;
