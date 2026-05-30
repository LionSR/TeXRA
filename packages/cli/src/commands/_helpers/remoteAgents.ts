import { getAgent, loadAgents, type AgentEntry } from '@agent/index';

import { getCliAuthProvider } from '@cli/runtime/supabaseAuth';

export async function shouldHonorRemoteAgentPriority(
  agentName: string,
): Promise<boolean> {
  if (agentName.includes(':')) return false;
  return getCliAuthProvider().isAuthenticated();
}

/**
 * Resolve an agent from the local registry, falling back to a full
 * (remote-inclusive) reload when it is missing or remote agents should take
 * priority. Callers must populate the local registry first (typically via
 * `loadAgents({ includeRemote: false })`).
 */
export async function resolveAgentWithRemoteFallback(
  name: string,
): Promise<AgentEntry | undefined> {
  let agent = getAgent(name);
  if (!agent || (await shouldHonorRemoteAgentPriority(name))) {
    await loadAgents();
    agent = getAgent(name);
  }
  return agent;
}
