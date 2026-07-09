import type { AgentEvent, AgentTrace } from '@agent/trace';
import type {
  AddOutputFilesPayload,
  GoalPausedPayload,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateTodosPayload,
} from '@shared/schemas';

/**
 * Durable run facts ride the run trace as explicit `AgentEvent` arms.
 * Host/public-output compatibility adapters may still project these facts
 * outward, but producers no longer encode them through the `domain` escape
 * hatch.
 */
export type RunFactPayloads = {
  updateTodos: UpdateTodosPayload;
  updatePlan: UpdatePlanPayload;
  addOutputFiles: AddOutputFilesPayload;
  updateMissingOutputs: UpdateMissingOutputsPayload;
  updateCompileFailures: UpdateCompileFailuresPayload;
  goalPaused: GoalPausedPayload;
};

export type RunFactEventName = keyof RunFactPayloads;

export function emitRunFact<K extends RunFactEventName>(
  trace: AgentTrace,
  event: K,
  payload: RunFactPayloads[K],
): void {
  trace.emit({ type: event, ...payload } as Extract<AgentEvent, { type: K }>);
}
