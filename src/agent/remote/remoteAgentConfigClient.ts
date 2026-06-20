// Third-party imports
import { StatusCodes } from 'http-status-codes';

// Local imports - auth
import { SUPABASE_CONFIG } from '@auth/config';

// Local imports - agent
import { EdgeFunctionResponseSchema } from './types';

/** Fetch raw remote-agent YAML from the edge function. */
export async function fetchRemoteAgentConfigYaml(
  agentName: string,
  accessToken: string,
): Promise<string> {
  const response = await fetch(SUPABASE_CONFIG.edgeFunctionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agentName }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      mapRemoteAgentConfigHttpError(response.status, agentName, errorText),
    );
  }

  return EdgeFunctionResponseSchema.parse(await response.json()).config;
}

/** Maps edge-function HTTP status codes to user-friendly error messages. */
function mapRemoteAgentConfigHttpError(
  status: number,
  agentName: string,
  errorText: string,
): string {
  switch (status) {
    case StatusCodes.UNAUTHORIZED:
      return 'Session expired. Sign in again to continue.';

    case StatusCodes.FORBIDDEN:
      return `Access denied to agent "${agentName}". Upgrade your account for access.`;

    case StatusCodes.NOT_FOUND:
      return `Agent "${agentName}" not found or access denied. Verify the agent name and your permissions.`;

    case StatusCodes.INTERNAL_SERVER_ERROR:
      if (errorText.includes('Failed to load agent configuration')) {
        return (
          `Failed to load agent "${agentName}": The agent configuration file could not be retrieved from storage. ` +
          `This may indicate the agent's YAML file is missing or the storage path in the database is incorrect. ` +
          `Please contact the TeXRA team if this agent should be available.`
        );
      }
      return `Failed to load agent: ${StatusCodes[status]} - ${errorText}`;

    default:
      return `Failed to load agent: ${StatusCodes[status] || status} - ${errorText}`;
  }
}
