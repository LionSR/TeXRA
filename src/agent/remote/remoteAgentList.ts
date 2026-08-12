/**
 * Listing half of the remote-agent client: metadata rows only, no YAML parsing
 * and no tool resolution.
 *
 * Split out of `RemoteAgentLoader.ts` on purpose. The agent index reaches this
 * module (`@agent/index/agentRegistry` -> `remoteAgentMeta`), and the agent
 * index is reachable from tool modules such as `@tools/bash`. Keeping
 * `@tools/registry` — which imports every tool, including the LaTeX, Lean,
 * arxiv and Zotero ones — out of this file is what stops a generic tool's
 * module closure from dragging the whole domain-tool set behind it. Config
 * loading (which genuinely needs `resolveToolDefinitions`) stays in
 * `RemoteAgentLoader.ts`, which nothing under `src/tools/` reaches.
 */
import ky, { HTTPError } from 'ky';
import { z } from 'zod';

import { SUPABASE_CONFIG } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import * as logger from '@logger/logUtils';
import { filterNotNull } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { errorDataToString, FETCH_TIMEOUT_MS } from './errorData';
import { RemoteAgentListItemSchema, type RemoteAgentListItem } from './types';

export const CHANNEL = 'RemoteAgentLoader';

const REMOTE_AGENT_LIST_COLUMNS =
  'id, name, description, visibility, tools, agent_category';

interface RemoteAgentListRow {
  id: string;
  name: string;
  description?: string | null;
  visibility?: string[] | null;
  tools?: string[] | null;
  agent_category: string;
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

/** List all available remote agents for the current user. */
export async function listRemoteAgents(): Promise<RemoteAgentListItem[]> {
  try {
    const token = await SupabaseClient.getAccessToken();
    if (!token) return [];

    const { data, error } = await fetchRemoteAgentListRows(token);

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

async function fetchRemoteAgentListRows(
  accessToken: string,
): Promise<RemoteAgentListQueryResult> {
  const url = new URL('/rest/v1/remote_agents', SUPABASE_CONFIG.url);
  url.searchParams.set('select', REMOTE_AGENT_LIST_COLUMNS);
  url.searchParams.set('order', 'name.asc');

  try {
    // retry: 0 preserves the old fetch's fail-fast contract — listRemoteAgents
    // is awaited by registry/settings refreshes and treats failure as an empty
    // list, so ky's default GET retries (which honor Retry-After on 429/503)
    // would block the UI rather than surfacing immediately.
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
