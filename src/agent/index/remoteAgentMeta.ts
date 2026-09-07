/** Remote agent metadata persistence and loading for the agent registry. */

import { Effect } from 'effect';
import { RemoteAgentListError } from '@agent/remote/errorData';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import { AgentCategory } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { AgentEntry } from './agentEntry';

const log = createLog('agentRegistry');

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
  return platform().globalState.get<RemoteAgentMetaCache>(
    GlobalStateKey.REMOTE_AGENT_META_CACHE,
    {},
  );
}

export function loadRemoteAgents(): Effect.Effect<AgentEntry[]> {
  return Effect.gen(function* () {
    const { listRemoteAgents } = yield* Effect.tryPromise({
      try: () => import('@agent/remote/remoteAgentList'),
      catch: (cause) =>
        new RemoteAgentListError({ message: toErrorMessage(cause), cause }),
    });
    const remotes = yield* listRemoteAgents();
    const metaCache = getPersistedRemoteAgentMeta();

    return remotes.map((remote) => {
      const cached = metaCache[remote.name];
      return {
        name: remote.name,
        source: 'remote' as const,
        path: '',
        category:
          remote.agentCategory === AgentCategory.ToolUse
            ? AgentCategory.ToolUse
            : AgentCategory.Workflow,
        description: remote.description ?? undefined,
        tools: remote.tools?.length ? remote.tools : cached?.tools,
        defaultOutputFiles: cached?.defaultOutputFiles,
      };
    });
  }).pipe(
    Effect.catch((error: RemoteAgentListError) =>
      Effect.sync(() => {
        log.warn(`Failed to load remote agents: ${error.message}`);
        return [];
      }),
    ),
  );
}
