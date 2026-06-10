import { getAgent, loadAgents, type AgentEntry } from '@agent/index';

import { getCliAuthProvider } from './supabaseAuth';

async function shouldHonorRemoteAgentPriority(
  agentName: string,
): Promise<boolean> {
  if (agentName.includes(':')) return false;
  return getCliAuthProvider().isAuthenticated();
}

/**
 * Resolve a CLI launch target from the agent registry.
 *
 * The lookup owns the full local/remote loading policy: commands do not
 * pre-load agents before calling it. Local built-ins are loaded first; then a
 * full remote-inclusive reload runs when the agent is missing locally or an
 * authenticated relay session should prefer remote agent definitions.
 */
export async function resolveCliAgent(
  name: string,
): Promise<AgentEntry | undefined> {
  await loadAgents({ includeRemote: false });
  let agent = getAgent(name);
  if (!agent || (await shouldHonorRemoteAgentPriority(name))) {
    await loadAgents();
    agent = getAgent(name);
  }
  return agent;
}
