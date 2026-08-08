import type { RemoteAgent } from '@shared/schemas/settingsViewMessages';
import type { AgentEntry } from './agentEntry';

export function toRemoteAgentProfileData(entry: AgentEntry): RemoteAgent {
  return {
    name: entry.name,
    description: entry.description ?? '',
    visibility: entry.visibility ?? ['public'],
    category: entry.category,
    supportsMultipleOutput: (entry.defaultOutputFiles?.length ?? 0) > 0,
  };
}
