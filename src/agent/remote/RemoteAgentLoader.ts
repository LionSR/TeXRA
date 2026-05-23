import { StatusCodes } from 'http-status-codes';
import yaml from 'yaml';

import {
  type AgentSetting,
  AgentPromptSchema,
  AgentSettingSchema,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';
import {
  getAgent,
  extractToolNames,
  updateAgentDescription,
  updateAgentTools,
  updateAgentDefaultOutputFiles,
} from '@agent/index/agentRegistry';
import { SUPABASE_CONFIG } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { toErrorMessage } from '@common/errors/errorMessage';
import * as logger from '@logger/logUtils';
import { resolveToolDefinitions } from '@tools/registry';

import {
  RemoteAgentListItemSchema,
  EdgeFunctionResponseSchema,
  type RemoteAgentListItem,
  type RemoteAgentConfig,
} from './types';

const CHANNEL = 'RemoteAgentLoader';
logger.initialize(CHANNEL);

const REMOTE_AGENT_LIST_COLUMNS =
  'id, name, description, visibility, tools, agent_category';
const LEGACY_REMOTE_AGENT_LIST_COLUMNS =
  'id, name, description, visibility, agent_category';

interface RemoteAgentListRow {
  id: string;
  name: string;
  description?: string | null;
  visibility?: string[] | null;
  tools?: string[] | null;
  agent_category?: string | null;
}

interface RemoteAgentListQueryError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/**
 * True only for the pre-migration database shape where `remote_agents.tools`
 * does not exist yet. Other query errors should surface directly.
 */
export function isMissingRemoteAgentToolsColumnError(
  error: RemoteAgentListQueryError | null | undefined,
): boolean {
  if (!error) return false;

  const text = [error.message, error.details, error.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  const schemaError =
    error.code === 'PGRST204' ||
    error.code === '42703' ||
    text.includes('schema cache') ||
    text.includes('column');

  return schemaError && /\btools\b/.test(text);
}

/** Maps HTTP status codes to user-friendly error messages. */
function mapHttpError(
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

/** Parse DB row to RemoteAgentListItem, returning null on validation failure. */
function parseListItemRow(row: RemoteAgentListRow): RemoteAgentListItem | null {
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
  /** Load a remote agent configuration by name. */
  static async loadRemoteAgent(agentName: string): Promise<RemoteAgentConfig> {
    if (!(await SupabaseClient.isAuthenticated())) {
      throw new Error(
        'Remote agents require authentication. Sign in using the "TeXRA: Sign In" command.',
      );
    }

    logger.info(CHANNEL, `Loading remote agent: ${agentName}`);

    try {
      const config = await fetchAgentConfig(agentName);

      const registryId = `remote:${agentName}`;
      if (config.description) {
        updateAgentDescription(registryId, config.description);
      }
      updateAgentTools(registryId, config.tools);
      updateAgentDefaultOutputFiles(registryId, config.defaultOutputFiles);

      logger.info(CHANNEL, `Successfully loaded remote agent: ${agentName}`);

      return {
        settings: config.settings,
        prompts: config.prompts,
      };
    } catch (error) {
      const lastError =
        error instanceof Error ? error : new Error(toErrorMessage(error));
      logger.error(
        CHANNEL,
        `Failed to load remote agent "${agentName}": ${lastError.message}`,
      );
      throw lastError;
    }
  }

  /** List all available remote agents for the current user. */
  static async listRemoteAgents(): Promise<RemoteAgentListItem[]> {
    try {
      const token = await SupabaseClient.getAccessToken();
      if (!token) return [];

      const { data, error } = await queryRemoteAgentListRows(token);

      if (error) {
        logger.debug(CHANNEL, `Failed to list remote agents: ${error.message}`);
        return [];
      }

      return (data ?? [])
        .map(parseListItemRow)
        .filter((item): item is RemoteAgentListItem => item !== null);
    } catch (error) {
      logger.debug(
        CHANNEL,
        `Error listing remote agents: ${toErrorMessage(error)}`,
      );
      return [];
    }
  }
}

async function queryRemoteAgentListRows(accessToken: string): Promise<{
  data: RemoteAgentListRow[] | null;
  error: RemoteAgentListQueryError | null;
}> {
  const current = await fetchRemoteAgentListRows(
    accessToken,
    REMOTE_AGENT_LIST_COLUMNS,
  );

  if (!current.error) {
    return {
      data: current.data as RemoteAgentListRow[] | null,
      error: null,
    };
  }

  if (!isMissingRemoteAgentToolsColumnError(current.error)) {
    return { data: null, error: current.error };
  }

  logger.debug(
    CHANNEL,
    `Remote agent tools column unavailable; using legacy list query: ${current.error.message}`,
  );

  const legacy = await fetchRemoteAgentListRows(
    accessToken,
    LEGACY_REMOTE_AGENT_LIST_COLUMNS,
  );

  return {
    data: legacy.data as RemoteAgentListRow[] | null,
    error: legacy.error,
  };
}

async function fetchRemoteAgentListRows(
  accessToken: string,
  columns: string,
): Promise<{
  data: RemoteAgentListRow[] | null;
  error: RemoteAgentListQueryError | null;
}> {
  const url = new URL('/rest/v1/remote_agents', SUPABASE_CONFIG.url);
  url.searchParams.set('select', columns);
  url.searchParams.set('order', 'name.asc');

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_CONFIG.publicKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (response.ok) {
    return {
      data: (await response.json()) as RemoteAgentListRow[],
      error: null,
    };
  }

  const fallbackMessage = `${response.status} ${response.statusText}`.trim();
  const rawBody = await response.text().catch(() => '');
  const error = parseRemoteAgentListErrorBody(rawBody);
  return {
    data: null,
    error: {
      ...error,
      message: error.message || fallbackMessage || 'remote list request failed',
    },
  };
}

function parseRemoteAgentListErrorBody(
  rawBody: string,
): RemoteAgentListQueryError {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody) as RemoteAgentListQueryError;
  } catch {
    return { message: rawBody };
  }
}

/** Fetch and parse agent config from edge function. */
async function fetchAgentConfig(agentName: string): Promise<{
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
    body: JSON.stringify({ agentName }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    const message = mapHttpError(response.status, agentName, errorText);
    throw new Error(message);
  }

  const responseData = EdgeFunctionResponseSchema.parse(await response.json());

  logger.debug(CHANNEL, `Parsing YAML for remote agent: ${agentName}`);
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
