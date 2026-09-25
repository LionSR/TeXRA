import { Duration, Effect } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { StatusCodes } from 'http-status-codes';

import { SUPABASE_CONFIG } from '@auth/config';
import { ensureError } from '@utils/errors/errorMessage';

import { FETCH_TIMEOUT_MS } from './errorData';
import { EdgeFunctionResponseSchema } from './types';

/**
 * Fetch raw remote-agent YAML from the edge function. The edge function is
 * this file's one foreign edge, wrapped here so its readers compose instead
 * of each re-adopting the same request.
 */
export const fetchRemoteAgentConfigYaml = (
  agentName: string,
  accessToken: string,
): Effect.Effect<string, Error, HttpClient.HttpClient> =>
  HttpClient.execute(
    HttpClientRequest.post(SUPABASE_CONFIG.edgeFunctionUrl).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({ agentName }),
    ),
  ).pipe(
    Effect.flatMap((response): Effect.Effect<string, Error> =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(
            Effect.flatMap((body) =>
              Effect.try({
                try: () => EdgeFunctionResponseSchema.parse(body).config,
                catch: ensureError,
              }),
            ),
          )
        : response.text.pipe(
            Effect.flatMap((text) =>
              Effect.fail(
                new Error(
                  mapRemoteAgentConfigHttpError(
                    response.status,
                    agentName,
                    text || 'Unknown error',
                  ),
                ),
              ),
            ),
          ),
    ),
    Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
  );

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
