import * as path from 'node:path';

import { isFileNotFoundError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

import { AbsoluteFS } from './absoluteFS';

const log = createLog('rulesUtils');

const RULES_FILE = '.texrarules';

/**
 * Load `.texrarules` from `workspace` (the run's workspace root, when one is
 * open) or the user's home directory. Returns the trimmed content or an empty
 * string if none found.
 */
export async function loadTexraRules(
  workspace: string | undefined,
): Promise<string> {
  try {
    if (workspace) {
      const workspaceFile = path.join(workspace, RULES_FILE);
      if (await AbsoluteFS.exists(workspaceFile)) {
        const trimmed = (await AbsoluteFS.read(workspaceFile)).trim();
        if (trimmed) {
          log.debug(`Loaded workspace ${RULES_FILE}`);
          return trimmed;
        }
      }
    }

    const homeDir = safeHomedir();
    if (homeDir) {
      const homeFile = path.join(homeDir, RULES_FILE);
      if (await AbsoluteFS.exists(homeFile)) {
        const trimmed = (await AbsoluteFS.read(homeFile)).trim();
        if (trimmed) {
          log.debug(`Loaded home ${RULES_FILE}`);
          return trimmed;
        }
      }
    }
  } catch (err) {
    if (isFileNotFoundError(err)) return '';
    log.warn(`Failed to load ${RULES_FILE}: ${toErrorMessage(err)}`);
  }
  return '';
}
