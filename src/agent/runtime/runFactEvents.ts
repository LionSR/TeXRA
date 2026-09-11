import type { AgentEvent, AgentTrace } from '@agent/trace';
import { formatResultCount } from '@utils/text/stringUtils';

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
    round: number;
    missing: string[];
    xmlFile: string | null;
  },
): void {
  const { round, missing, xmlFile } = info;
  trace.domain({
    key: 'missingOutputs',
    text: `${formatResultCount(missing.length, 'output file')} missing`,
    data: { missing, xmlFile },
  });
  emitRunFact(trace, 'updateMissingOutputs', {
    filesByRound: { [round]: missing },
  });
}
