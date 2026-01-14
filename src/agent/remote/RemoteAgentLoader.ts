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
import { getMultipleName, getBaseName } from '@agent/index/agentRegistry';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';
import { SupabaseClient } from '@/auth/SupabaseClient';
import { SUPABASE_CONFIG } from '@/auth/config';

import {
  RemoteAgentMetadataSchema,
  type RemoteAgentMetadata,
  type RemoteAgentConfig,
  type RemoteAgentLoadOptions,
} from './types';

const CHANNEL = 'RemoteAgentLoader';
logger.initialize(CHANNEL);

/**
 * Maps HTTP status codes to user-friendly error messages.
 * Extracted to simplify the error handling in loadRemoteAgent.
 */
function mapHttpError(
  status: number,
  agentName: string,
  candidateName: string,
  isLastCandidate: boolean,
  errorText: string,
): { message: string; shouldContinue: boolean } {
  switch (status) {
    case StatusCodes.UNAUTHORIZED:
      return {
        message: 'Session expired. Sign in again to continue.',
        shouldContinue: false,
      };

    case StatusCodes.NOT_FOUND:
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

    case StatusCodes.FORBIDDEN:
      return {
        message: `Access denied to agent "${agentName}". Upgrade your account for access.`,
        shouldContinue: false,
      };

    case StatusCodes.INTERNAL_SERVER_ERROR:
      if (errorText.includes('Failed to load agent configuration')) {
        return {
          message:
            `Failed to load agent "${agentName}": The agent configuration file could not be retrieved from storage. ` +
            `This may indicate the agent's YAML file is missing or the storage path in the database is incorrect. ` +
            `Please contact the TeXRA team if this agent should be available.`,
          shouldContinue: false,
        };
      }
      // Fall through to default
      break;
  }

  return {
    message: `Failed to load agent: ${StatusCodes[status] || status} - ${errorText}`,
    shouldContinue: false,
  };
}

/**
 * Maps a database row to RemoteAgentMetadata using schema validation.
 * Shared between listRemoteAgents and getAgentMetadata.
 */
function parseMetadataRow(row: {
  id: string;
  name: string;
  description?: string | null;
  visibility?: string[] | null;
  agent_category?: string | null;
}): RemoteAgentMetadata | null {
  const result = RemoteAgentMetadataSchema.safeParse({
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    agentCategory: row.agent_category,
  });

  if (!result.success) {
    logger.warn(
      CHANNEL,
      `Invalid metadata for agent "${row.name}": ${result.error.message}`,
    );
    return null;
  }
  return result.data;
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
          let errorText = 'Unknown error';
          try {
            errorText = await response.text();
          } catch {
            logger.warn(CHANNEL, 'Failed to read error response body');
          }

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

        const responseData = await response.json();
        const {
          config: yamlContent,
          name: responseName,
          description,
          visibility,
          agentCategory,
        } = responseData;

        if (!yamlContent) {
          throw new Error(
            'Server returned empty configuration. Contact support.',
          );
        }

        // Parse YAML configuration
        logger.debug(
          CHANNEL,
          `Parsing YAML for remote agent: ${candidateName}`,
        );
        const parsed = yaml.parse(yamlContent);
        const validated = AgentDefinitionSchema.parse(parsed);

        // Extract settings and prompts
        // Note: Remote agents are expected to be self-contained (no inheritance).
        // If inherits field is present, it's ignored - merge should happen on upload.
        const settings: Partial<AgentSetting> = validated.settings;
        const prompts: Partial<AgentPrompt> = validated.prompts;

        // Resolve tool names to definitions using shared utility
        if (Array.isArray(settings.tools)) {
          const { resolveToolDefinitions } = await import('@tools/registry');
          settings.tools = resolveToolDefinitions(
            settings.tools as (string | { name: string })[],
            (name) =>
              logger.warn(CHANNEL, `Tool "${name}" not found in registry`),
          );
        }

        const validatedSettings = parseAgentSetting(settings);
        const validatedPrompts = AgentPromptSchema.parse(prompts);

        logger.info(
          CHANNEL,
          `Successfully loaded remote agent: ${agentName} (resolved to ${candidateName})`,
        );

        // Build metadata from edge function response with schema validation
        // The edge function returns camelCase fields, which matches the schema directly
        const metadata = RemoteAgentMetadataSchema.parse({
          id: '', // Not returned by edge function, not used by consumers
          name: responseName || agentName,
          description: description,
          visibility: visibility,
          agentCategory: agentCategory,
        });

        return {
          name: validated.name || responseName || agentName,
          settings: validatedSettings,
          prompts: validatedPrompts,
          metadata,
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

  /**
   * List all available remote agents for the current user.
   */
  static async listRemoteAgents(): Promise<RemoteAgentMetadata[]> {
    const isAuth = await SupabaseClient.isAuthenticated();
    if (!isAuth) {
      return [];
    }

    try {
      const tokens = await SupabaseClient.getSessionTokens();
      if (!tokens) {
        return [];
      }

      const supabase = SupabaseClient.getClient();

      // Set auth session for RLS - requires both tokens
      await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      // RLS will automatically filter based on user's permissions
      const { data, error } = await supabase
        .from('remote_agents')
        .select('id, name, description, visibility, agent_category')
        .order('name');

      if (error) {
        logger.error(CHANNEL, `Failed to list remote agents: ${error.message}`);
        return [];
      }

      // Map snake_case DB columns to camelCase and validate
      // Use safeParse to filter invalid records without breaking the entire list
      return (data ?? [])
        .map((row) => parseMetadataRow(row))
        .filter((item): item is RemoteAgentMetadata => item !== null);
    } catch (error) {
      logger.error(
        CHANNEL,
        `Error listing remote agents: ${toErrorMessage(error)}`,
      );
      return [];
    }
  }

  /**
   * Get metadata for a specific remote agent.
   */
  static async getAgentMetadata(
    agentName: string,
  ): Promise<RemoteAgentMetadata | null> {
    try {
      const tokens = await SupabaseClient.getSessionTokens();
      if (!tokens) {
        return null;
      }

      const supabase = SupabaseClient.getClient();

      // Set auth session for RLS - requires both tokens
      await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      const { data, error } = await supabase
        .from('remote_agents')
        .select('id, name, description, visibility, agent_category')
        .eq('name', agentName)
        .single();

      if (error || !data) {
        logger.warn(
          CHANNEL,
          `No metadata found for remote agent: ${agentName}`,
        );
        return null;
      }

      return parseMetadataRow(data);
    } catch (error) {
      logger.error(
        CHANNEL,
        `Error fetching metadata for ${agentName}: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }
}
