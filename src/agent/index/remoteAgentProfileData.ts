import type { RemoteAgent } from '@shared/schemas/profileViewMessages';
import type { AgentEntry } from './agentRegistry';

export function toRemoteAgentProfileData(entry: AgentEntry): RemoteAgent {
  return {
    name: entry.name,
    description: entry.description ?? '',
    visibility: entry.visibility ?? ['public'],
    category: entry.category,
    supportsMultipleOutput: entry.isMultiple ?? false,
  };
}
