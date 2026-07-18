import * as path from 'node:path';

import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

const CHANNEL = 'rulesUtils';

const RULES_FILE = '.texrarules';

/**
 * Load `.texrarules` from the workspace root or the user's home directory.
 * Returns the trimmed content or an empty string if none found.
 */
export async function loadTexraRules(): Promise<string> {
  try {
    const workspacePath = WorkspaceFS.getPath();

    if (workspacePath && (await WorkspaceFS.exists(RULES_FILE))) {
      const trimmed = (await WorkspaceFS.read(RULES_FILE)).trim();
      if (trimmed) {
        logger.debug(CHANNEL, `Loaded workspace ${RULES_FILE}`);
        return trimmed;
      }
    }

    const homeDir = safeHomedir();
    if (homeDir) {
      const homeFile = path.join(homeDir, RULES_FILE);
      if (await AbsoluteFS.exists(homeFile)) {
        const trimmed = (await AbsoluteFS.read(homeFile)).trim();
        if (trimmed) {
          logger.debug(CHANNEL, `Loaded home ${RULES_FILE}`);
          return trimmed;
        }
      }
    }
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to load ${RULES_FILE}: ${toErrorMessage(err)}`,
    );
  }
  return '';
}
