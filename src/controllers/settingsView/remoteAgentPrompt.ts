import { Effect } from 'effect';
import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SupabaseAuth } from '@auth/SupabaseAuth';

import type { HttpClient } from 'effect/unstable/http';

/**
 * Fetch a hosted agent's prompt YAML for viewing. Returns null when the user
 * is not signed in; the caller owns how that is surfaced.
 */
export const fetchRemoteAgentPromptYaml = Effect.fn(
  'remoteAgentPrompt.fetchRemoteAgentPromptYaml',
)(function* (
  agentName: string,
): Effect.fn.Return<
  string | null,
  Error,
  SupabaseAuth | HttpClient.HttpClient
> {
  const auth = yield* SupabaseAuth;
  const token = yield* auth.accessToken;
  if (!token) return null;
  return yield* fetchRemoteAgentConfigYaml(agentName, token);
});
