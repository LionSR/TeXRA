// Local imports - utilities
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

// Local imports - log
import * as log from '@logger/logUtils';

const CHANNEL = 'frontend.vars';
log.initialize(CHANNEL);

/**
 * Reads a file and populates user variable fields with its path and content.
 * Logs informative messages on success or warnings on failure.
 *
 * @param filePath - Path to the file
 * @param varName - Variable name prefix (without _FILE or _CONTENT)
 * @param userVars - Object to store the populated variables
 * @param source - String describing the origin of the file (for log messages)
 * @param absolute - Interpret filePath as absolute rather than workspace-relative
 * @returns True if the file was read successfully, false otherwise
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  userVars: Record<string, any>,
  source: string,
  absolute: boolean = false,
): Promise<boolean> {
  try {
    const fileContent = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.readFile(filePath);
    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;
    log.info(CHANNEL, `[${source}] Found [VAR '${varName}']: ${filePath}`);
    return true;
  } catch (err) {
    log.warn(CHANNEL, `[${source}] [VAR '${varName}'] not found: ${filePath}`);
    return false;
  }
}
