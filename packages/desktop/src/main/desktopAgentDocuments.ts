import { Data, Effect } from 'effect';
import { getAgent, getCatalogAgents } from '@agent/index';
import { AGENT_SOURCE, agentKey, isPackagedAgentSource } from '@shared/schemas';
import {
  agentDocumentIdentity,
  agentDocumentTarget,
} from '../shared/desktopAgentDocument.js';

export class AgentDocumentUnavailable extends Data.TaggedError(
  'AgentDocumentUnavailable',
)<{
  readonly message: string;
}> {}

/** Resolve each read/save afresh, including after a renderer or app restart.
 * A removed definition cannot keep an old file grant alive. */
export function resolveAgentDocument(target: string, write: boolean) {
  return Effect.gen(function* () {
    const identity = agentDocumentIdentity(target);
    const entry =
      identity && getAgent(agentKey(identity.source, identity.name));
    if (!entry?.path) {
      return yield* Effect.fail(
        new AgentDocumentUnavailable({
          message:
            'This agent definition is no longer available. Open its current definition from Settings.',
        }),
      );
    }
    if (write && isPackagedAgentSource(entry.source)) {
      return yield* Effect.fail(
        new AgentDocumentUnavailable({
          message:
            'Built-in and plugin definitions are read-only. Customize the agent to edit a copy.',
        }),
      );
    }
    return entry.path;
  });
}

/** The settings controller already resolved this file. Include shadowed
 * packaged definitions so “View built-in” still opens the original. */
export function agentDocumentForPath(filePath: string) {
  for (const item of getCatalogAgents()) {
    for (const source of Object.values(AGENT_SOURCE)) {
      const entry = getAgent(agentKey(source, item.name));
      if (entry?.path === filePath) {
        return agentDocumentTarget(source, entry.name);
      }
    }
  }
  return undefined;
}
