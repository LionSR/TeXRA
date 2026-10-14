/**
 * The documents plugin's read of a run's output files for the hosts'
 * latexdiff orchestration, and where the toolbar's Pack puts them.
 */
import * as path from 'node:path';

import { HISTORY_DIR } from '@housekeeping/constants';
import { generateTimestamp } from '@housekeeping/utils';
import {
  agentFileName,
  type OutputFileInfo,
  type RunId,
} from '@shared/schemas';
import { modelFileName } from '@texra/utils/files/outputFileUtils';
import { documentsOf } from '@texra/shared/plugins/documents';
import { type ReadonlyRoundIndexed } from '@texra/shared/plugins/documentOutputs';
import type { SessionView } from '@texra-ai/harness';

/**
 * One run's recorded output files by round, from a view of the session that
 * holds it: a document task's documents, which hosts hand to latexdiff.
 */
export function runOutputFiles(
  view: SessionView,
  runId: RunId,
): ReadonlyRoundIndexed<OutputFileInfo> {
  const run = view.runs.get(runId);
  return run === undefined ? {} : documentsOf(run).files;
}

/**
 * Where the toolbar's Pack snapshots a run's directory: a workspace-relative
 * folder under `History/`, named for the input, agent and model, with a run
 * id fragment so two runs packed within the same second (the timestamp's
 * granularity) don't collide. The copy itself is the session's `run.files`,
 * done by the process that holds the run.
 */
export function packDestination({
  runId,
  agent,
  model,
  inputFile,
}: {
  readonly runId: RunId;
  readonly agent: string;
  readonly model: string;
  readonly inputFile: string;
}): string {
  const baseName = inputFile ? path.parse(inputFile).name : 'run';
  const idFragment = runId.replaceAll('-', '').slice(0, 8);
  return path.posix.join(
    HISTORY_DIR,
    `${generateTimestamp()}_${baseName}_${agentFileName(agent)}_${modelFileName(model)}_${idFragment}`,
  );
}
