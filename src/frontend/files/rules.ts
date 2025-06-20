// Standard library imports
import * as os from 'os';
import * as path from 'path';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { fileExistsAbsolute, readFileAbsolute } from '@utils/files';

const CHANNEL = 'texraRulesUtils';
logger.initialize(CHANNEL);

/**
 * Load `.texrarules` from the workspace root or the user's home directory.
 * @returns The rules content trimmed or an empty string if none found.
 */
export async function loadTexraRules(): Promise<string> {
  try {
    const workspacePath = WorkspaceFS.getPath();
    const rulesFile = '.texrarules';

    if (workspacePath && (await WorkspaceFS.exists(rulesFile))) {
      const content = await WorkspaceFS.readFile(rulesFile);
      if (content.trim()) {
        logger.debug(CHANNEL, `Loaded workspace ${rulesFile}`);
        return content.trim();
      }
    }

    const homeFile = path.join(os.homedir(), rulesFile);
    if (await fileExistsAbsolute(homeFile)) {
      const content = await readFileAbsolute(homeFile);
      if (content.trim()) {
        logger.debug(CHANNEL, `Loaded home ${rulesFile}`);
        return content.trim();
      }
    }
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to load ${'.texrarules'}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return '';
}
