// Node imports
import * as path from 'node:path';

// Local imports
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { ExecutionId, FileOpResult } from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { findRunDir } from '@utils/files/runStorageFs';

// Local file imports
import { CHANNEL, HISTORY_DIR } from './constants';
import { generateTimestamp } from './utils';

const log = createLog(CHANNEL);

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
  log.info(
    `Packing runDir for execution ${executionId} (agent=${agent}, model=${model}, inputFile=${inputFile})`,
  );

  const runDirAbsolute = await findRunDir(executionId);
  if (!runDirAbsolute) {
    log.warn(`Run directory not found for execution ${executionId}`);
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
    log.info(`Packed runDir ${runDirAbsolute} -> ${destinationAbsolute}`);
    return { status: 'success', outputFolder: destinationRelative };
  } catch (error) {
    const message = toErrorMessage(error);
    log.error(`Pack runDir failed: ${message}`, { data: error });
    return { status: 'error', error: message };
  }
}

/**
 * Delete a run's runDir. Irreversible. Used when the user discards a run
 * from the progress-view toolbar.
 */
export async function runCleanRunDir(
  executionId: ExecutionId,
): Promise<FileOpResult> {
  const runDirAbsolute = await findRunDir(executionId);
  if (!runDirAbsolute) {
    log.warn(`Run directory not found for execution ${executionId}`);
    return { status: 'noFiles' };
  }

  log.info(`Removing runDir for execution ${executionId}: ${runDirAbsolute}`);

  try {
    await platform().fs.delete(runDirAbsolute, { recursive: true });
    return { status: 'success' };
  } catch (error) {
    const message = toErrorMessage(error);
    log.error(`Clean runDir failed: ${message}`, { data: error });
    return { status: 'error', error: message };
  }
}
