// Third-party imports
import { globIterate } from 'glob';

// Internal imports
import { createLog } from '@logger/logUtils';
import { EXCLUDED_DIRS } from '@shared/constants/latexTiming';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { CHANNEL } from './constants';

const log = createLog(CHANNEL);

export async function runCleanBuild(): Promise<void> {
  log.debug('Starting build directory cleanup');

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return;
  }

  const ignorePatterns = [...EXCLUDED_DIRS]
    .filter((dir) => dir !== 'build')
    .map((dir) => `**/${dir}/**`);

  for await (const dir of globIterate('**/build', {
    cwd: workspacePath,
    ignore: ignorePatterns,
    nodir: false,
  })) {
    try {
      await WorkspaceFS.delete(dir, { recursive: true, useTrash: false });
      log.debug(`Removed build directory: ${dir}`);
    } catch (err) {
      log.error(
        `Error removing build directory ${dir}: ${toErrorMessage(err)}`,
      );
    }
  }

  log.info('Build directories cleaned');
}
