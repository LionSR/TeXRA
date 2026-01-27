import * as os from 'os';
import * as path from 'path';

import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

const CHANNEL = 'rulesUtils';
logger.initialize(CHANNEL);

const RULES_FILE = '.texrarules';

/**
 * Load `.texrarules` from the workspace root or the user's home directory.
 * Returns the trimmed content or an empty string if none found.
 */
export async function loadTexraRules(): Promise<string> {
  try {
    const workspacePath = WorkspaceFS.getPath();

    if (workspacePath && (await WorkspaceFS.exists(RULES_FILE))) {
      const content = await WorkspaceFS.read(RULES_FILE);
      if (content.trim()) {
        logger.debug(CHANNEL, `Loaded workspace ${RULES_FILE}`);
        return content.trim();
      }
    }

    const homeFile = path.join(os.homedir(), RULES_FILE);
    if (await AbsoluteFS.exists(homeFile)) {
      const content = await AbsoluteFS.read(homeFile);
      if (content.trim()) {
        logger.debug(CHANNEL, `Loaded home ${RULES_FILE}`);
        return content.trim();
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
