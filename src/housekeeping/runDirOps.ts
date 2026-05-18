// Standard library imports
import * as path from 'path';

// Local imports
import { platform } from '@platform/platform';
import { getCleanAgentName } from '@agent/index';
import type { FileOpResult } from '@agent/types/ResultTypes';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files';
import { resolveRunDir } from '@utils/files/taskRunStorage';

import { HISTORY_DIR } from './constants';
import { generateTimestamp } from './utils';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

/**
 * Snapshot a completed run's runDir into `workspace/History/`. Symlinks
 * are dereferenced so the snapshot is a self-contained copy.
 */
export async function runPackRunDir(
  executionId: ExecutionId,
  agent: string,
  model: string,
  inputFile: string,
): Promise<FileOpResult> {
  logger.info(
    CHANNEL,
    `Packing runDir for execution ${executionId} (agent=${agent}, model=${model}, inputFile=${inputFile})`,
  );

  const runDirAbsolute = await resolveRunDir(executionId);
  if (!runDirAbsolute) {
    logger.warn(
      CHANNEL,
      `Run directory not found for execution ${executionId}`,
    );
    return { status: 'noFiles' };
  }

  const baseName = inputFile ? path.parse(inputFile).name : 'run';
  const cleanAgent = getCleanAgentName(agent);
  // Include an executionId fragment in the destination folder so two packs
  // of the same input+agent+model within the same second (the timestamp's
  // granularity) don't collide and silently merge via `errorOnExist: false`.
  const idFragment = executionId.replaceAll('-', '').slice(0, 8);
  const destinationRelative = path.join(
    HISTORY_DIR,
    `${generateTimestamp()}_${baseName}_${cleanAgent}_${model}_${idFragment}`,
  );
  const destinationAbsolute = WorkspaceFS.fullPath(destinationRelative);

  try {
    await WorkspaceFS.createDir(destinationRelative);
    await platform().fs.copy(runDirAbsolute, destinationAbsolute, {
      overwrite: true,
      dereference: true,
    });
    logger.info(
      CHANNEL,
      `Packed runDir ${runDirAbsolute} -> ${destinationAbsolute}`,
    );
    return { status: 'success', outputFolder: destinationRelative };
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(CHANNEL, `Pack runDir failed: ${message}`, { data: error });
    return { status: 'error', error: message };
  }
}

/**
 * Delete a run's runDir. Irreversible. Used when the user discards a run
 * from the progress-view toolbar. Resolves through `resolveRunDir` so the
 * legacy `taskRuns/` location is cleaned up too.
 */
export async function runCleanRunDir(
  executionId: ExecutionId,
): Promise<FileOpResult> {
  const runDirAbsolute = await resolveRunDir(executionId);
  if (!runDirAbsolute) {
    logger.warn(
      CHANNEL,
      `Run directory not found for execution ${executionId}`,
    );
    return { status: 'noFiles' };
  }

  logger.info(
    CHANNEL,
    `Removing runDir for execution ${executionId}: ${runDirAbsolute}`,
  );

  try {
    await platform().fs.delete(runDirAbsolute, { recursive: true });
    return { status: 'success' };
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(CHANNEL, `Clean runDir failed: ${message}`, { data: error });
    return { status: 'error', error: message };
  }
}
