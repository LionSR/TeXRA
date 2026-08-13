import { StatusCodes } from 'http-status-codes';
import ky, { HTTPError } from 'ky';

import { SUPABASE_CONFIG } from '@auth/config';

import { errorDataToString, FETCH_TIMEOUT_MS } from './errorData';
import { EdgeFunctionResponseSchema } from './types';

/** Fetch raw remote-agent YAML from the edge function. */
export async function fetchRemoteAgentConfigYaml(
  agentName: string,
  accessToken: string,
): Promise<string> {
  try {
    const data = await ky
      .post(SUPABASE_CONFIG.edgeFunctionUrl, {
        json: { agentName },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: false,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      .json<unknown>();
    return EdgeFunctionResponseSchema.parse(data).config;
  } catch (error) {
    if (error instanceof HTTPError) {
      const errorText = errorDataToString(error.data) ?? 'Unknown error';
      throw new Error(
        mapRemoteAgentConfigHttpError(
          error.response.status,
          agentName,
          errorText,
        ),
      );
    }
    throw error;
  }
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
      return `Access denied to agent "${agentName}". Your account does not have permission to access this remote agent.`;

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
