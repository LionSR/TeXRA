import ky, { HTTPError } from 'ky';
import { z } from 'zod';

import {
  type AgentSettingInput,
  AgentPromptSchema,
  AgentSettingSchema,
  AgentDefinitionSchema,
} from '@agent/core/definition/AgentDataclass';
import { extractToolNames, updateAgentMeta } from '@agent/index/agentRegistry';
import { SUPABASE_CONFIG } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import * as logger from '@logger/logUtils';
import { resolveToolDefinitions, type RawToolConfig } from '@tools/registry';

import { filterNotNull, filterNotNullish } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { errorDataToString } from './errorData';
import {
  RemoteAgentListItemSchema,
  type RemoteAgentListItem,
  type RemoteAgentConfig,
} from './types';
import { fetchRemoteAgentConfigYaml } from './remoteAgentConfigClient';

const CHANNEL = 'RemoteAgentLoader';
logger.initialize(CHANNEL);

const FETCH_TIMEOUT_MS = 30_000;

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

const RemoteAgentListQueryErrorSchema = z.object({
  code: z.string().nullish(),
  message: z.string().nullish(),
  details: z.string().nullish(),
  hint: z.string().nullish(),
});
type RemoteAgentListQueryError = z.infer<
  typeof RemoteAgentListQueryErrorSchema
>;

type RemoteAgentListQueryResult = {
  data: RemoteAgentListRow[] | null;
  error: RemoteAgentListQueryError | null;
};

/**
 * True only for the pre-migration database shape where `remote_agents.tools`
 * does not exist yet. Other query errors should surface directly.
 */
export function isMissingRemoteAgentToolsColumnError(
  error: RemoteAgentListQueryError | null | undefined,
): boolean {
  if (!error) return false;

  const text = [error.message, error.details, error.hint]
    .filter(filterNotNullish)
    .join(' ')
    .toLowerCase();
  const schemaError =
    error.code === 'PGRST204' ||
    error.code === '42703' ||
    text.includes('schema cache') ||
    text.includes('column');

  return schemaError && /\btools\b/.test(text);
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
      `Invalid metadata for agent "${row.name}": ${z.prettifyError(result.error)}`,
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
      updateAgentMeta(registryId, {
        description: config.description,
        tools: config.tools,
        defaultOutputFiles: config.defaultOutputFiles,
      });

      logger.info(CHANNEL, `Successfully loaded remote agent: ${agentName}`);

      return {
        settings: config.settings,
        prompts: config.prompts,
      };
    } catch (error) {
      const lastError = ensureError(error);
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

      return (data ?? []).map(parseListItemRow).filter(filterNotNull);
    } catch (error) {
      logger.debug(
        CHANNEL,
        `Error listing remote agents: ${toErrorMessage(error)}`,
      );
      return [];
    }
  }
}

async function queryRemoteAgentListRows(
  accessToken: string,
): Promise<RemoteAgentListQueryResult> {
  const current = await fetchRemoteAgentListRows(
    accessToken,
    REMOTE_AGENT_LIST_COLUMNS,
  );

  if (!current.error || !isMissingRemoteAgentToolsColumnError(current.error)) {
    return current;
  }

  logger.debug(
    CHANNEL,
    `Remote agent tools column unavailable; using legacy list query: ${current.error.message}`,
  );

  return fetchRemoteAgentListRows(
    accessToken,
    LEGACY_REMOTE_AGENT_LIST_COLUMNS,
  );
}

async function fetchRemoteAgentListRows(
  accessToken: string,
  columns: string,
): Promise<RemoteAgentListQueryResult> {
  const url = new URL('/rest/v1/remote_agents', SUPABASE_CONFIG.url);
  url.searchParams.set('select', columns);
  url.searchParams.set('order', 'name.asc');

  try {
    // retry: 0 preserves the old fetch's fail-fast contract — listRemoteAgents
    // is awaited by registry/settings refreshes and treats failure as an empty
    // list, so ky's default GET retries (which honor Retry-After on 429/503)
    // would block the UI rather than surfacing immediately. AbortSignal.timeout
    // (vs ky's header-only `timeout`) also guards the .json() body read.
    const data = await ky
      .get(url, {
        headers: {
          apikey: SUPABASE_CONFIG.publicKey,
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        retry: 0,
        timeout: false,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      .json<RemoteAgentListRow[]>();
    return { data, error: null };
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error;

    // ky v2 auto-consumes the response body into error.data;
    // error.response body methods are not usable after that.
    const rawBody = errorDataToString(error.data);
    const parsedError = rawBody
      ? parseJsonWith(rawBody, RemoteAgentListQueryErrorSchema).unwrapOr({
          message: rawBody,
        })
      : {};
    const fallbackMessage =
      `${error.response.status} ${error.response.statusText}`.trim();
    return {
      data: null,
      error: {
        ...parsedError,
        message:
          parsedError.message ||
          fallbackMessage ||
          'remote list request failed',
      },
    };
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

  const configYaml = await fetchRemoteAgentConfigYaml(agentName, token);

  logger.debug(CHANNEL, `Parsing YAML for remote agent: ${agentName}`);
  const parsedYaml = parseYamlWith(configYaml, AgentDefinitionSchema);
  if (parsedYaml.isErr()) {
    throw new Error(
      `Failed to parse YAML for remote agent "${agentName}": ${parsedYaml.error.message}`,
      { cause: parsedYaml.error },
    );
  }
  const validated = parsedYaml.value;

  // Extract metadata before resolving tools to full definitions (for registry cache)
  const settings: AgentSettingInput = validated.settings;
  const toolNames = extractToolNames(settings.tools);
  const defaultOutputFiles = settings.defaultOutputFiles;

  // Process tool definitions (remote agents are self-contained)
  const resolvedSettings = Array.isArray(settings.tools)
    ? {
        ...settings,
        tools: resolveToolDefinitions(
          settings.tools as RawToolConfig[],
          (name) =>
            logger.warn(CHANNEL, `Tool "${name}" not found in registry`),
        ),
      }
    : settings;

  return {
    settings: AgentSettingSchema.parse(resolvedSettings),
    prompts: AgentPromptSchema.parse(validated.prompts),
    description: validated.description,
    tools: toolNames?.length ? toolNames : undefined,
    defaultOutputFiles: defaultOutputFiles?.length
      ? defaultOutputFiles
      : undefined,
  };
}
