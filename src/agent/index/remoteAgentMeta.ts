/** Remote agent metadata persistence and loading for the agent registry. */

import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { AgentCategory } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { AgentEntry } from './agentEntry';

const CHANNEL = 'agentRegistry';

/**
 * Cached metadata for a remote agent, persisted in globalState.
 * Populated lazily when a remote agent's YAML is first loaded.
 */
interface RemoteAgentMetaCache {
  [agentName: string]: {
    tools?: string[];
    defaultOutputFiles?: string[];
  };
}

/** Persist remote agent metadata to globalState for cross-session availability. */
export function persistRemoteAgentMeta(
  agentName: string,
  meta: { tools?: string[]; defaultOutputFiles?: string[] },
): void {
  const stored = getPersistedRemoteAgentMeta();
  stored[agentName] = { ...stored[agentName], ...meta };
  void platform().globalState.update(
    GlobalStateKey.REMOTE_AGENT_META_CACHE,
    stored,
  );
}

/** Load persisted remote agent metadata from globalState. */
function getPersistedRemoteAgentMeta(): RemoteAgentMetaCache {
  return (
    platform().globalState.get<RemoteAgentMetaCache>(
      GlobalStateKey.REMOTE_AGENT_META_CACHE,
      {},
    ) ?? {}
  );
}

export async function loadRemoteAgents(): Promise<AgentEntry[]> {
  try {
    const { listRemoteAgents } = await import('@agent/remote/remoteAgentList');
    const remotes = await listRemoteAgents();
    const metaCache = getPersistedRemoteAgentMeta();

    return remotes.map((remote) => {
      const isToolUse = remote.agentCategory === AgentCategory.ToolUse;
      const cached = metaCache[remote.name];
      const dbTools = remote.tools?.length ? remote.tools : undefined;
      return {
        name: remote.name,
        source: 'remote' as const,
        path: '',
        category: isToolUse ? AgentCategory.ToolUse : AgentCategory.Workflow,
        description: remote.description ?? undefined,
        visibility: remote.visibility ?? undefined,
        tools: dbTools ?? cached?.tools,
        defaultOutputFiles: cached?.defaultOutputFiles,
      };
    });
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to load remote agents: ${toErrorMessage(err)}`,
    );
    return [];
  }
}
