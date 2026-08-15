import type { AgentEvent, AgentTrace } from '@agent/trace';
import type {
  AddOutputFilesPayload,
  GoalPausedPayload,
  UpdateCompileFailuresPayload,
  UpdateMissingOutputsPayload,
  UpdatePlanPayload,
  UpdateTodosPayload,
} from '@shared/schemas';
import { formatResultCount } from '@utils/text/stringUtils';

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
 * missing-outputs observation goes through here.
 *
 * The `missingOutputs` domain row is the human-facing transcript log and is
 * deliberately distinct from the `updateMissingOutputs` run fact below: it
 * carries only the round's unmatched outputs and the XML file they were
 * expected in.
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
  trace.domain({
    key: 'missingOutputs',
    text: `${formatResultCount(info.missing.length, 'output file')} missing`,
    data: { missing: info.missing, xmlFile: info.xmlFile },
  });
  emitRunFact(trace, 'updateMissingOutputs', {
    streamId: info.streamId,
    filesByRound: { [info.round]: info.missing },
  });
}
