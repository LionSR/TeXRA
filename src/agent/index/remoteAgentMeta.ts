/** Current remote catalog metadata for the agent registry. */

import { Effect } from 'effect';
import { RemoteAgentListError } from '@agent/remote/errorData';
import { createLog } from '@logger/logUtils';
import { AgentCategory } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { AgentEntry } from './agentEntry';

const log = createLog('agentRegistry');

export function loadRemoteAgents(): Effect.Effect<AgentEntry[]> {
  return Effect.gen(function* () {
    const { listRemoteAgents } = yield* Effect.tryPromise({
      try: () => import('@agent/remote/remoteAgentList'),
      catch: (cause) =>
        new RemoteAgentListError({ message: toErrorMessage(cause), cause }),
    });
    const remotes = yield* listRemoteAgents();

    return remotes.map((remote) => {
      return {
        name: remote.name,
        source: 'remote' as const,
        path: '',
        category:
          remote.agentCategory === AgentCategory.ToolUse
            ? AgentCategory.ToolUse
            : AgentCategory.Workflow,
        description: remote.description ?? undefined,
        tools: remote.tools ?? undefined,
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
