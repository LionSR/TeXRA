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
  // Precedence order: the run's workspace, then the home directory. A root
  // whose file is absent or blank falls through to the next one.
  const candidates: Array<{ root: string; source: string }> = [];
  if (workspace) candidates.push({ root: workspace, source: 'workspace' });
  const homeDir = safeHomedir();
  if (homeDir) candidates.push({ root: homeDir, source: 'home' });

  try {
    for (const { root, source } of candidates) {
      const file = path.join(root, RULES_FILE);
      if (!(await AbsoluteFS.exists(file))) continue;
      const trimmed = (await AbsoluteFS.read(file)).trim();
      if (!trimmed) continue;
      log.debug(`Loaded ${source} ${RULES_FILE}`);
      return trimmed;
    }
  } catch (err) {
    if (isFileNotFoundError(err)) return '';
    log.warn(`Failed to load ${RULES_FILE}: ${toErrorMessage(err)}`);
  }
  return '';
}
