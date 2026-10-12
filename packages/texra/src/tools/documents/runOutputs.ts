/**
 * The documents plugin's read of a run's output files for the hosts'
 * latexdiff orchestration, and where the toolbar's Pack puts them.
 */
import * as path from 'node:path';

import { Effect } from 'effect';

import { HISTORY_DIR } from '@housekeeping/constants';
import { generateTimestamp } from '@housekeeping/utils';
import {
  agentFileName,
  type OutputFileInfo,
  type ReadonlyRoundIndexed,
  type RunId,
} from '@shared/schemas';
import { modelFileName } from '@texra/utils/files/outputFileUtils';
import { documentsOf } from '@texra/shared/plugins/documents';
import type { SessionView } from '@texra-ai/harness';

/**
 * One run's recorded output files by round, from a view of the session that
 * holds it (`view`, asked for the run): a document task's documents. Hosts
 * hand it to latexdiff orchestration, whose run-discovery port it satisfies.
 */
export function runOutputReader(
  view: (runId: RunId) => Effect.Effect<SessionView>,
): {
  readonly readRunOutputs: (
    runId: RunId,
  ) => Effect.Effect<ReadonlyRoundIndexed<OutputFileInfo>, Error>;
} {
  return {
    readRunOutputs: (runId) =>
      view(runId).pipe(
        Effect.map((level) => {
          const run = level.runs.get(runId);
          return run === undefined ? {} : documentsOf(run).files;
        }),
      ),
  };
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
