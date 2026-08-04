import {
  logMissingOutputs,
  type AgentEvent,
  type AgentTrace,
} from '@agent/trace';
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
type RunFactPayloads = {
  updateTodos: UpdateTodosPayload;
  updatePlan: UpdatePlanPayload;
  addOutputFiles: AddOutputFilesPayload;
  updateMissingOutputs: UpdateMissingOutputsPayload;
  updateCompileFailures: UpdateCompileFailuresPayload;
  goalPaused: GoalPausedPayload;
};

type RunFactEventName = keyof RunFactPayloads;

export function emitRunFact<K extends RunFactEventName>(
  trace: AgentTrace,
  event: K,
  payload: RunFactPayloads[K],
): void {
  trace.emit({ type: event, ...payload } as Extract<AgentEvent, { type: K }>);
}

/**
 * One report, two artifacts: the human-facing transcript row and the
 * `updateMissingOutputs` run fact always travel together, so the sidecar
 * accumulator and the transcript can never diverge. Every producer of a
 * missing-outputs observation goes through here — never `logMissingOutputs`
 * alone.
 */
export function reportMissingOutputs(
  trace: AgentTrace,
  info: {
    streamId: string;
    round: number;
    missing: string[];
    xmlFile: string | null;
  },
): void {
  logMissingOutputs(trace, { missing: info.missing, xmlFile: info.xmlFile });
  emitRunFact(trace, 'updateMissingOutputs', {
    streamId: info.streamId,
    filesByRound: { [info.round]: info.missing },
  });
}
