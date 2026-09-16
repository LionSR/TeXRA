import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SupabaseClient } from '@auth/SupabaseClient';

/**
 * Fetch a hosted agent's prompt YAML for viewing. Returns null when the user
 * is not signed in; the caller owns how that is surfaced.
 */
export async function fetchRemoteAgentPromptYaml(
  agentName: string,
): Promise<string | null> {
  const token = await SupabaseClient.getAccessToken();
  if (!token) return null;
  return fetchRemoteAgentConfigYaml(agentName, token);
}
