import { getCliAuthProvider } from '../../runtime/supabaseAuth';

export async function shouldHonorRemoteAgentPriority(
  agentName: string,
): Promise<boolean> {
  if (agentName.includes(':')) return false;
  return getCliAuthProvider().isAuthenticated();
}
