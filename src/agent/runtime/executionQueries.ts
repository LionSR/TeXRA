import { agentName as normalizeAgentName } from '@shared/schemas/agent';

import { currentSession, type SessionHandle } from './SessionHandle';

export interface RuntimeExecutionQueryOptions {
  readonly session?: SessionHandle;
}

export interface RuntimeActiveAgentNameRequest extends RuntimeExecutionQueryOptions {
  readonly agentName: string;
}

/** Return whether a normalized agent name already has an active execution. */
export function hasRuntimeActiveAgentName({
  agentName,
  session = currentSession(),
}: RuntimeActiveAgentNameRequest): boolean {
  const expected = normalizeAgentName(agentName);
  return session.executions
    .getAgentHandles()
    .some((handle) => normalizeAgentName(handle.agentName) === expected);
}
