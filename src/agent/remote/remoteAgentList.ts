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
import { z } from 'zod';

import { Cause, Duration, Effect, Result } from 'effect';
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from 'effect/unstable/http';
import { SUPABASE_CONFIG } from '@auth/config';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { withLogChannel } from '@logger/effectLog';
import { filterNotNull } from '@utils/core';

import { FETCH_TIMEOUT_MS, RemoteAgentListError } from './errorData';
import { RemoteAgentListItemSchema, type RemoteAgentListItem } from './types';

export const CHANNEL = 'RemoteAgentLoader';

const REMOTE_AGENT_LIST_COLUMNS =
  'id, name, description, tools, agent_category';

/** One DB row, renamed onto the list item's camelCase column. */
const RemoteAgentListRowSchema = z
  .looseObject({ agent_category: z.unknown() })
  .transform(({ agent_category, ...row }) => ({
    ...row,
    agentCategory: agent_category,
  }))
  .pipe(RemoteAgentListItemSchema);

const RemoteAgentListQueryErrorSchema = z.object({
  message: z.string().nullish(),
});

/** Parse one DB row, returning null (logged) on validation failure. */
function parseListItemRow(
  row: unknown,
): Effect.Effect<RemoteAgentListItem | null> {
  const result = RemoteAgentListRowSchema.safeParse(row);
  if (result.success) return Effect.succeed(result.data);
  const name =
    typeof row === 'object' && row !== null && 'name' in row
      ? String(row.name)
      : 'unknown';
  return Effect.logWarning(
    `Invalid metadata for agent "${name}": ${z.prettifyError(result.error)}`,
  ).pipe(withLogChannel(CHANNEL), Effect.as(null));
}

/**
 * List all available remote agents for the current user. The listing is a
 * best-effort projection behind registry/settings refreshes: a signed-out
 * user — including a composition with no account plane to sign in to — an
 * unreachable relay, or a rejected query all yield an empty list (logged at
 * debug) rather than a failure of the catalog load that awaits it.
 */
export function listRemoteAgents(): Effect.Effect<
  RemoteAgentListItem[],
  never,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    // `serviceOption`, not a required service: the embeddable agent package
    // composes no account plane, and its catalog load answers signed-out.
    const auth = yield* Effect.serviceOption(SupabaseAuth);
    if (auth._tag === 'None') return [];
    const token = yield* auth.value.accessToken;
    if (!token) return [];

    const rows = yield* fetchRemoteAgentListRows(token);
    const items = yield* Effect.forEach(rows, parseListItemRow);
    return items.filter(filterNotNull);
  }).pipe(
    Effect.catch((error: RemoteAgentListError) =>
      Effect.logWarning(`Error listing remote agents: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
        Effect.as([]),
      ),
    ),
  );
}

function fetchRemoteAgentListRows(
  accessToken: string,
): Effect.Effect<
  ReadonlyArray<unknown>,
  RemoteAgentListError,
  HttpClient.HttpClient
> {
  const url = new URL('/rest/v1/remote_agents', SUPABASE_CONFIG.url);
  url.searchParams.set('select', REMOTE_AGENT_LIST_COLUMNS);
  url.searchParams.set('order', 'name.asc');

  // No retries (HttpClient's default): listRemoteAgents is awaited by
  // registry/settings refreshes and treats failure as an empty list, so a
  // retried request would block the UI rather than surface immediately.
  // Interrupting the load aborts the request.
  return HttpClient.execute(
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader('apikey', SUPABASE_CONFIG.publicKey),
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.acceptJson,
    ),
  ).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(
            Effect.flatMap((body) => {
              const rows = z.array(z.unknown()).safeParse(body);
              return rows.success
                ? Effect.succeed(rows.data)
                : Effect.fail(
                    new RemoteAgentListError({
                      message: 'remote list response is not an array',
                      cause: rows.error,
                    }),
                  );
            }),
          )
        : response.text.pipe(
            Effect.flatMap((text) =>
              Effect.fail(remoteAgentListStatusError(response.status, text)),
            ),
          ),
    ),
    Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
    Effect.mapError(
      (
        error:
          | RemoteAgentListError
          | HttpClientError.HttpClientError
          | Cause.TimeoutError,
      ) =>
        error instanceof RemoteAgentListError
          ? error
          : new RemoteAgentListError({ message: error.message, cause: error }),
    ),
  );
}

/** A rejected list request, worded from the query's own error body when the
 *  relay sent one. */
function remoteAgentListStatusError(
  status: number,
  text: string,
): RemoteAgentListError {
  const parsed = Result.getOrUndefined(
    parseJsonWith(text, RemoteAgentListQueryErrorSchema),
  );
  return new RemoteAgentListError({
    message: parsed?.message || text || `HTTP ${status}`,
  });
}
