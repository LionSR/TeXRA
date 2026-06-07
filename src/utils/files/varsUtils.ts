import * as logger from '@logger/logUtils';

import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

/**
 * Reads a file and populates user variable fields with its path and content.
 * Sets `${varName}_FILE` and `${varName}_CONTENT` in the provided userVars object.
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  userVars: Record<string, unknown>,
  absolute: boolean = false,
): Promise<boolean> {
  try {
    const fileContent = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.read(filePath);
    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;
    return true;
  } catch (error) {
    logger.debug(
      'VarsUtils',
      `Failed to read ${varName} from file ${filePath}`,
      { data: error },
    );
    return false;
  }
}
