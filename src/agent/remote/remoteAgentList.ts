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
 * loading stays in `RemoteAgentLoader.ts`, which nothing under `src/tools/`
 * reaches.
 */
import ky, { HTTPError } from 'ky';
import { z } from 'zod';

import { Effect, Result } from 'effect';
import { SUPABASE_CONFIG } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { createLog } from '@logger/logUtils';
import { filterNotNull } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  errorDataToString,
  FETCH_TIMEOUT_MS,
  RemoteAgentListError,
} from './errorData';
import { RemoteAgentListItemSchema, type RemoteAgentListItem } from './types';

export const CHANNEL = 'RemoteAgentLoader';
const log = createLog(CHANNEL);

const REMOTE_AGENT_LIST_COLUMNS =
  'id, name, description, tools, agent_category';

interface RemoteAgentListRow {
  id: string;
  name: string;
  description?: string | null;
  tools?: string[] | null;
  agent_category: string;
}

const RemoteAgentListQueryErrorSchema = z.object({
  message: z.string().nullish(),
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
    tools: row.tools,
    agentCategory: row.agent_category,
  });

  if (!result.success) {
    log.warn(
      `Invalid metadata for agent "${row.name}": ${z.prettifyError(result.error)}`,
    );
    return null;
  }

  return result.data;
}

/**
 * List all available remote agents for the current user. The listing is a
 * best-effort projection behind registry/settings refreshes: a signed-out
 * user, an unreachable relay, or a rejected query all yield an empty list
 * (logged at debug) rather than a failure of the catalog load that awaits it.
 */
export function listRemoteAgents(): Effect.Effect<RemoteAgentListItem[]> {
  return Effect.gen(function* () {
    const token = yield* Effect.tryPromise({
      try: () => SupabaseClient.getAccessToken(),
      catch: (cause) =>
        new RemoteAgentListError({ message: toErrorMessage(cause), cause }),
    });
    if (!token) return [];

    const { data, error } = yield* fetchRemoteAgentListRows(token);

    if (error) {
      return yield* new RemoteAgentListError({
        message: error.message ?? 'remote list request failed',
      });
    }

    return (data ?? []).map(parseListItemRow).filter(filterNotNull);
  }).pipe(
    Effect.catch((error: RemoteAgentListError) =>
      Effect.sync(() => {
        log.debug(`Error listing remote agents: ${error.message}`);
        return [];
      }),
    ),
  );
}

function fetchRemoteAgentListRows(
  accessToken: string,
): Effect.Effect<RemoteAgentListQueryResult, RemoteAgentListError> {
  const url = new URL('/rest/v1/remote_agents', SUPABASE_CONFIG.url);
  url.searchParams.set('select', REMOTE_AGENT_LIST_COLUMNS);
  url.searchParams.set('order', 'name.asc');

  // retry: 0 preserves the old fetch's fail-fast contract — listRemoteAgents
  // is awaited by registry/settings refreshes and treats failure as an empty
  // list, so ky's default GET retries (which honor Retry-After on 429/503)
  // would block the UI rather than surfacing immediately.
  const request = Effect.tryPromise({
    try: () =>
      ky
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
        .json<RemoteAgentListRow[]>(),
    catch: (cause) => cause,
  });

  return request.pipe(
    Effect.map((data): RemoteAgentListQueryResult => ({ data, error: null })),
    Effect.catch((error: unknown) => {
      if (!(error instanceof HTTPError)) {
        return Effect.fail(
          new RemoteAgentListError({
            message: toErrorMessage(error),
            cause: error,
          }),
        );
      }

      const rawBody = errorDataToString(error.data);
      const parsedError = rawBody
        ? Result.getOrElse(
            parseJsonWith(rawBody, RemoteAgentListQueryErrorSchema),
            () => ({ message: rawBody }),
          )
        : {};
      const fallbackMessage =
        `${error.response.status} ${error.response.statusText}`.trim();
      return Effect.succeed({
        data: null,
        error: {
          ...parsedError,
          message:
            parsedError.message ||
            fallbackMessage ||
            'remote list request failed',
        },
      });
    }),
  );
}
