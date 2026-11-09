/** Where the toolbar's Pack puts a run's files. */
import * as path from 'node:path';

import { Effect } from 'effect';

import { agentFileName, type RunId } from '@texra-ai/harness/schemas';
import { HISTORY_DIR } from '@housekeeping/constants';
import { fileNameTimestamp } from '@housekeeping/artifactFiles';
import { modelFileName } from '@texra/utils/files/outputFileUtils';

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
}): Effect.Effect<string> {
  const baseName = inputFile ? path.parse(inputFile).name : 'run';
  const idFragment = runId.replaceAll('-', '').slice(0, 8);
  return Effect.map(fileNameTimestamp, (stamp) =>
    path.posix.join(
      HISTORY_DIR,
      `${stamp}_${baseName}_${agentFileName(agent)}_${modelFileName(model)}_${idFragment}`,
    ),
  );
}
