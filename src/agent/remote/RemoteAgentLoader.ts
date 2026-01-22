/**
 * Remote Agent Loader - loads agent configurations from Supabase.
 */

import { StatusCodes } from 'http-status-codes';
import yaml from 'yaml';

import {
  AgentSetting,
  AgentPrompt,
  AgentPromptSchema,
  parseAgentSetting,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';
import {
  getMultipleName,
  getBaseName,
  updateAgentDescription,
} from '@agent/index/agentRegistry';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';
import { SupabaseClient } from '@/auth/SupabaseClient';
import { SUPABASE_CONFIG } from '@/auth/config';

import {
  RemoteAgentListItemSchema,
  EdgeFunctionResponseSchema,
  type RemoteAgentListItem,
  type RemoteAgentConfig,
  type RemoteAgentLoadOptions,
} from './types';

const CHANNEL = 'RemoteAgentLoader';
logger.initialize(CHANNEL);

interface HttpErrorResult {
  message: string;
  shouldContinue: boolean;
}

const HTTP_ERROR_MESSAGES: Partial<
  Record<number, (agentName: string) => string>
> = {
  [StatusCodes.UNAUTHORIZED]: () =>
    'Session expired. Sign in again to continue.',
  [StatusCodes.FORBIDDEN]: (name) =>
    `Access denied to agent "${name}". Upgrade your account for access.`,
};

/** Maps HTTP status codes to user-friendly error messages. */
function mapHttpError(
  status: number,
  agentName: string,
  candidateName: string,
  isLastCandidate: boolean,
  errorText: string,
): HttpErrorResult {
  // Handle static error messages
  const staticMessage = HTTP_ERROR_MESSAGES[status];
  if (staticMessage) {
    return { message: staticMessage(agentName), shouldContinue: false };
  }

  // Handle 404 with fallback logic
  if (status === StatusCodes.NOT_FOUND) {
    if (!isLastCandidate) {
      logger.debug(
        CHANNEL,
        `Agent variant "${candidateName}" not found, trying next candidate`,
      );
      return {
        message: `Agent variant "${candidateName}" not found`,
        shouldContinue: true,
      };
    }
    return {
      message: `Agent "${agentName}" not found or access denied. Verify the agent name and your permissions.`,
      shouldContinue: false,
    };
  }

  // Handle 500 with storage-specific message
  if (
    status === StatusCodes.INTERNAL_SERVER_ERROR &&
    errorText.includes('Failed to load agent configuration')
  ) {
    return {
      message:
        `Failed to load agent "${agentName}": The agent configuration file could not be retrieved from storage. ` +
        `This may indicate the agent's YAML file is missing or the storage path in the database is incorrect. ` +
        `Please contact the TeXRA team if this agent should be available.`,
      shouldContinue: false,
    };
  }

  return {
    message: `Failed to load agent: ${StatusCodes[status] || status} - ${errorText}`,
    shouldContinue: false,
  };
}

/** Maps a database row to RemoteAgentListItem using schema validation. */
function parseListItemRow(row: {
  id: string;
  name: string;
  description?: string | null;
  visibility?: string[] | null;
  agent_category?: string | null;
}): RemoteAgentListItem | null {
  const { id, name, description, visibility, agent_category } = row;
  const result = RemoteAgentListItemSchema.safeParse({
    id,
    name,
    description,
    visibility,
    agentCategory: agent_category,
  });
  if (!result.success) {
    logger.warn(CHANNEL, `Invalid metadata for agent "${name}": ${result.error.message}`);
    return null;
  }
  return result.data;
}

/** Set up authenticated Supabase session for database queries. Returns null if not authenticated. */
async function getAuthenticatedClient() {
  const tokens = await SupabaseClient.getSessionTokens();
  if (!tokens) return null;

  const supabase = SupabaseClient.getClient();
  await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  return supabase;
}

/**
 * Loader for remote agents stored in Supabase.
 * Fetches agent configurations via Edge Function with authentication.
 */
export class RemoteAgentLoader {
  /**
   * Load a remote agent configuration by name.
   * Supports _multiple variant: if agentName ends with _multiple, tries to load
   * the _multiple variant first, then falls back to base agent if not found.
   */
  static async loadRemoteAgent(
    agentName: string,
    options?: RemoteAgentLoadOptions,
  ): Promise<RemoteAgentConfig> {
    // Check if user is authenticated
    const isAuth = await SupabaseClient.isAuthenticated();
    if (!isAuth) {
      throw new Error(
        'Remote agents require authentication. Sign in using the "TeXRA: Sign In" command.',
      );
    }

    // Check if remote agents are enabled
    const enabled = getConfig<boolean>('remoteAgents.enabled', true);
    if (!enabled) {
      throw new Error(
        'Remote agents are disabled. Enable them in settings: texra.remoteAgents.enabled',
      );
    }

    const preferMultiple = options?.preferMultiple ?? false;

    // Build candidate names:
    // - If preferMultiple: try _multiple first, then base as fallback
    // - If not preferMultiple: use agentName as-is (already resolved by registry)
    const candidateNames: string[] = [];

    if (preferMultiple) {
      const multipleName = getMultipleName(agentName);
      candidateNames.push(multipleName);
      // Add base as fallback if different
      const baseName = getBaseName(agentName);
      if (baseName !== multipleName) {
        candidateNames.push(baseName);
      }
    } else {
      candidateNames.push(agentName);
    }

    logger.info(
      CHANNEL,
      `Loading remote agent: ${agentName} (preferMultiple: ${preferMultiple}, candidates: ${candidateNames.join(', ')})`,
    );

    // Try each candidate name in order
    let lastError: Error | null = null;
    for (const candidateName of candidateNames) {
      try {
        // Get auth token
        const token = await SupabaseClient.getAccessToken();
        if (!token) {
          throw new Error(
            'Authentication token unavailable. Try signing in again.',
          );
        }

        // Fetch agent config from edge function
        const response = await fetch(SUPABASE_CONFIG.edgeFunctionUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agentName: candidateName }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          const isLastCandidate = candidateName === candidateNames.at(-1);
          const { message, shouldContinue } = mapHttpError(
            response.status,
            agentName,
            candidateName,
            isLastCandidate,
            errorText,
          );

          if (shouldContinue) {
            lastError = new Error(message);
            continue;
          }
          throw new Error(message);
        }

        // Validate edge function response
        const responseData = EdgeFunctionResponseSchema.parse(
          await response.json(),
        );
        const yamlContent = responseData.config;

        logger.debug(
          CHANNEL,
          `Parsing YAML for remote agent: ${candidateName}`,
        );
        const parsed = yaml.parse(yamlContent);
        const validated = AgentDefinitionSchema.parse(parsed);

        // Extract and process settings (remote agents are self-contained, no inheritance)
        const settings: Partial<AgentSetting> = validated.settings;
        if (Array.isArray(settings.tools)) {
          const { resolveToolDefinitions } = await import('@tools/registry');
          settings.tools = resolveToolDefinitions(
            settings.tools as (string | { name: string })[],
            (name) =>
              logger.warn(CHANNEL, `Tool "${name}" not found in registry`),
          );
        }

        logger.info(
          CHANNEL,
          `Successfully loaded remote agent: ${agentName} (resolved to ${candidateName})`,
        );

        // Update registry cache with description from YAML
        // Use base name since registry stores entries under base name only
        if (validated.description) {
          const baseName = getBaseName(agentName);
          updateAgentDescription(`remote:${baseName}`, validated.description);
        }

        return {
          settings: parseAgentSetting(settings),
          prompts: AgentPromptSchema.parse(validated.prompts),
        };
      } catch (error) {
        // If this is the last candidate, throw the error
        if (candidateName === candidateNames.at(-1)) {
          logger.error(
            CHANNEL,
            `Failed to load remote agent "${agentName}": ${toErrorMessage(error)}`,
          );
          throw error;
        }
        // Otherwise, store the error and continue to next candidate
        lastError =
          error instanceof Error ? error : new Error(toErrorMessage(error));
        logger.debug(
          CHANNEL,
          `Failed to load candidate "${candidateName}", trying next: ${lastError.message}`,
        );
      }
    }

    // If we get here, all candidates failed
    throw (
      lastError ||
      new Error(`Failed to load remote agent "${agentName}" after all attempts`)
    );
  }

  /** List all available remote agents for the current user. */
  static async listRemoteAgents(): Promise<RemoteAgentListItem[]> {
    if (!(await SupabaseClient.isAuthenticated())) return [];

    try {
      const supabase = await getAuthenticatedClient();
      if (!supabase) return [];

      const { data, error } = await supabase
        .from('remote_agents')
        .select('id, name, description, visibility, agent_category')
        .order('name');

      if (error) {
        logger.error(CHANNEL, `Failed to list remote agents: ${error.message}`);
        return [];
      }

      return (data ?? [])
        .map(parseListItemRow)
        .filter((item): item is RemoteAgentListItem => item !== null);
    } catch (error) {
      logger.error(
        CHANNEL,
        `Error listing remote agents: ${toErrorMessage(error)}`,
      );
      return [];
    }
  }
}
