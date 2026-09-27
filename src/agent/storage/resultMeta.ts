import type { ResultMeta, RunEnd, RunOutcome } from '@shared/schemas';

/**
 * The public value of one run's result endpoint (`readResult`): the run's
 * terminal result with the output as its delivery reported it, or a
 * background command's own record. The terminal fields are absent while the
 * run has not ended.
 */
export type RunResult =
  | Extract<ResultMeta, { producer: 'backgroundBash' }>
  | (Omit<RunEnd, 'outcome'> & { readonly outcome?: RunOutcome });

/**
 * A run's output as its delivery reported it: a subagent's delivered reply,
 * which only its producer record holds, or else the run's own output, plus
 * the diffs a workflow delivery computed after the flow reported. `output`
 * is the run's output as its rows derive it (`getRunRecords().readResult`).
 */
export function deliveredOutput(
  meta: Exclude<ResultMeta, { producer: 'backgroundBash' }>,
  output: RunEnd['output'],
): RunEnd['output'] {
  if (meta.producer === 'subagent' && meta.output.category === 'toolUse') {
    return meta.output;
  }
  if (output.category !== 'workflow') return output;
  return {
    ...output,
    diffs: meta.diffs,
    ...(meta.diffsUnavailable !== undefined
      ? { diffsUnavailable: meta.diffsUnavailable }
      : {}),
  };
}
