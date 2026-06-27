import type { ExecutionId } from '@shared/schemas';

import { currentSession, type SessionHandle } from './SessionHandle';

export interface RuntimeExecutionQueryOptions {
  readonly session?: SessionHandle;
}

/** Return ids for executions that are still active in the runtime session. */
export function getRuntimeActiveExecutionIds({
  session = currentSession(),
}: RuntimeExecutionQueryOptions = {}): ExecutionId[] {
  return session.executions.getActiveIds() as ExecutionId[];
}

/** Return agent names for active agent executions without exposing handles. */
export function getRuntimeActiveAgentNames({
  session = currentSession(),
}: RuntimeExecutionQueryOptions = {}): string[] {
  return session.executions.getAgentHandles().map((handle) => handle.agentName);
}
