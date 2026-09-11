import type { AgentEvent, AgentTrace } from '@agent/trace';

/**
 * Durable run facts ride the run trace as explicit `AgentEvent` arms:
 * producers no longer encode them through the `domain` escape hatch. The
 * fact is about the trace's own run, which the aggregate names, so the
 * payload carries no run id.
 */
type RunFact = Extract<
  AgentEvent,
  {
    type:
      | 'updateTodos'
      | 'updatePlan'
      | 'addOutputFiles'
      | 'updateMissingOutputs'
      | 'updateCompileFailures';
  }
>;

export function emitRunFact<K extends RunFact['type']>(
  trace: AgentTrace,
  event: K,
  payload: Omit<Extract<RunFact, { type: K }>, 'type' | 'stageId'>,
): void {
  trace.emit({ type: event, ...payload } as Extract<RunFact, { type: K }>);
}
