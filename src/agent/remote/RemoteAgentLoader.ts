import { StatusCodes } from 'http-status-codes';
import yaml from 'yaml';

import {
  type AgentSetting,
  AgentPromptSchema,
  AgentSettingSchema,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';
import {
  getMultipleName,
  getBaseName,
  getAgent,
  extractToolNames,
  updateAgentDescription,
  updateAgentTools,
  updateAgentDefaultOutputFiles,
} from '@agent/index/agentRegistry';
import type { AgentLoadOptions } from '@agent/runtime/agentLoad';
import * as logger from '@agent/core/logger';
import { SUPABASE_CONFIG } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { toErrorMessage } from '@common/errors/errorMessage';
import { resolveToolDefinitions } from '@tools/registry';

import {
  RemoteAgentListItemSchema,
  EdgeFunctionResponseSchema,
  type RemoteAgentListItem,
  type RemoteAgentConfig,
} from './types';

const CHANNEL = 'RemoteAgentLoader';
logger.initialize(CHANNEL);

/** Maps HTTP status codes to user-friendly error messages. */
function mapHttpError(
  status: number,
  agentName: string,
  candidateName: string,
  isLastCandidate: boolean,
  errorText: string,
): string {
  switch (status) {
    case StatusCodes.UNAUTHORIZED:
      return 'Session expired. Sign in again to continue.';

    case StatusCodes.FORBIDDEN:
      return `Access denied to agent "${agentName}". Upgrade your account for access.`;

    case StatusCodes.NOT_FOUND:
      if (!isLastCandidate) {
        logger.debug(
          CHANNEL,
          `Agent variant "${candidateName}" not found, trying next candidate`,
        );
        return `Agent variant "${candidateName}" not found`;
      }
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

/** Parse DB row to RemoteAgentListItem, returning null on validation failure. */
function parseListItemRow(row: {
  id: string;
  name: string;
  description?: string | null;
  visibility?: string[] | null;
  tools?: string[] | null;
  agent_category?: string | null;
}): RemoteAgentListItem | null {
  const result = RemoteAgentListItemSchema.safeParse({
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    tools: row.tools,
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

/** Loader for remote agents stored in Supabase. */
export class RemoteAgentLoader {
  /**
   * Load a remote agent configuration by name.
   * When preferMultiple is set, tries _multiple variant first, then falls back to base.
   */
  static async loadRemoteAgent(
    agentName: string,
    options?: AgentLoadOptions,
  ): Promise<RemoteAgentConfig> {
    if (!(await SupabaseClient.isAuthenticated())) {
      throw new Error(
        'Remote agents require authentication. Sign in using the "TeXRA: Sign In" command.',
      );
    }

    const candidateNames = buildCandidateNames(
      agentName,
      options?.preferMultiple ?? false,
    );

    logger.info(
      CHANNEL,
      `Loading remote agent: ${agentName} (candidates: ${candidateNames.join(', ')})`,
    );

    let lastError: Error | null = null;

    for (const candidateName of candidateNames) {
      const isLastCandidate = candidateName === candidateNames.at(-1);

      try {
        const config = await fetchAgentConfig(
          agentName,
          candidateName,
          isLastCandidate,
        );

        // Update registry cache with metadata from YAML.
        // Try base name first (normal case), then full name (_multiple-only agents
        // are registered under their full name, not the stripped base).
        const baseName = getBaseName(agentName);
        const registryId = getAgent(`remote:${baseName}`)
          ? `remote:${baseName}`
          : `remote:${agentName}`;
        if (config.description) {
          updateAgentDescription(registryId, config.description);
        }
        updateAgentTools(registryId, config.tools);
        updateAgentDefaultOutputFiles(registryId, config.defaultOutputFiles);

        logger.info(
          CHANNEL,
          `Successfully loaded remote agent: ${agentName} (resolved to ${candidateName})`,
        );

        return {
          settings: config.settings,
          prompts: config.prompts,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(toErrorMessage(error));

        if (isLastCandidate) {
          logger.error(
            CHANNEL,
            `Failed to load remote agent "${agentName}": ${lastError.message}`,
          );
          throw lastError;
        }

        logger.debug(
          CHANNEL,
          `Failed to load candidate "${candidateName}", trying next: ${lastError.message}`,
        );
      }
    }

    throw (
      lastError ||
      new Error(`Failed to load remote agent "${agentName}" after all attempts`)
    );
  }

  /** List all available remote agents for the current user. */
  static async listRemoteAgents(): Promise<RemoteAgentListItem[]> {
    if (!(await SupabaseClient.isAuthenticated())) return [];

    try {
      const tokens = await SupabaseClient.getSessionTokens();
      if (!tokens) return [];

      const supabase = SupabaseClient.getClient();
      await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      // Query with tools column; fall back without it for pre-migration databases.
      // PostgREST returns 400 if the column doesn't exist.
      let { data, error } = await supabase
        .from('remote_agents')
        .select('id, name, description, visibility, tools, agent_category')
        .order('name');

      if (error) {
        logger.debug(
          CHANNEL,
          `Query with tools column failed, retrying without: ${error.message}`,
        );
        const fallback = await supabase
          .from('remote_agents')
          .select('id, name, description, visibility, agent_category')
          .order('name');
        data = fallback.data as typeof data;
        error = fallback.error;
      }

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

/** Build candidate names for loading (multiple variant first if preferred). */
function buildCandidateNames(
  agentName: string,
  preferMultiple: boolean,
): string[] {
  if (!preferMultiple) {
    return [agentName];
  }

  const multipleName = getMultipleName(agentName);
  const baseName = getBaseName(agentName);

  return baseName !== multipleName ? [multipleName, baseName] : [multipleName];
}

/** Fetch and parse agent config from edge function. */
async function fetchAgentConfig(
  agentName: string,
  candidateName: string,
  isLastCandidate: boolean,
): Promise<{
  settings: RemoteAgentConfig['settings'];
  prompts: RemoteAgentConfig['prompts'];
  description?: string;
  tools?: string[];
  defaultOutputFiles?: string[];
}> {
  const token = await SupabaseClient.getAccessToken();
  if (!token) {
    throw new Error('Authentication token unavailable. Try signing in again.');
  }

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
    const message = mapHttpError(
      response.status,
      agentName,
      candidateName,
      isLastCandidate,
      errorText,
    );
    throw new Error(message);
  }

  const responseData = EdgeFunctionResponseSchema.parse(await response.json());

  logger.debug(CHANNEL, `Parsing YAML for remote agent: ${candidateName}`);
  const validated = AgentDefinitionSchema.parse(
    yaml.parse(responseData.config),
  );

  // Extract metadata before resolving tools to full definitions (for registry cache)
  const settings: Partial<AgentSetting> = validated.settings;
  const rawTools = settings.tools as (string | { name: string })[] | undefined;
  const toolNames = extractToolNames(rawTools);
  const defaultOutputFiles = settings.defaultOutputFiles as
    | string[]
    | undefined;

  // Process tool definitions (remote agents are self-contained)
  if (Array.isArray(settings.tools)) {
    settings.tools = resolveToolDefinitions(rawTools!, (name) =>
      logger.warn(CHANNEL, `Tool "${name}" not found in registry`),
    );
  }

  return {
    settings: AgentSettingSchema.parse(settings),
    prompts: AgentPromptSchema.parse(validated.prompts),
    description: validated.description,
    tools: toolNames?.length ? toolNames : undefined,
    defaultOutputFiles: defaultOutputFiles?.length
      ? defaultOutputFiles
      : undefined,
  };
}
