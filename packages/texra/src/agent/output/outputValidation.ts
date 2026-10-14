/**
 * Output validation for expected files.
 *
 * Validates that the current extraction wrote every expected output file,
 * reporting missing files for user notification.
 */

import { workflowOutputRoundDir } from '@texra/shared/constants/workflowOutput';

import {
  ensureRoundData,
  type OutputDependencies,
  type OutputState,
} from './outputState';

/**
 * Checks that the round's current extraction wrote each expected output
 * file. Its outputs are the authority on the expected files alone, never
 * the round directory, which still holds an earlier attempt's files: their
 * entries in the round's missing outputs are recomputed, and every other
 * entry (a document the reply held that did not extract) is kept.
 */
export function checkExpectedOutputs(
  state: OutputState,
  deps: OutputDependencies,
  currRound: number,
): void {
  const expected = deps.config.outputFiles;
  const round = ensureRoundData(state, currRound);
  // The round writes its outputs into its own directory; the run-root entry
  // of the same name is the workspace file, delivered only later.
  const written = new Set(
    round.outputs.map((output) => output.location.absolutePath),
  );
  const missing = expected.filter(
    (file) =>
      !written.has(
        deps.fileService.createLocation(
          `${workflowOutputRoundDir(currRound)}/${file}`,
        ).absolutePath,
      ),
  );
  if (expected.length > 0)
    deps.logger.debug(
      missing.length > 0
        ? `Missing expected outputs for round ${currRound}`
        : `All ${expected.length} expected outputs written in round ${currRound}`,
      { data: missing },
    );
  round.missingOutputs = [
    ...round.missingOutputs.filter((entry) => !expected.includes(entry)),
    ...missing,
  ];
}
