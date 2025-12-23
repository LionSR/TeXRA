// Local imports - utilities
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

/**
 * Reads a file and populates user variable fields with its path and content.
 * Logs informative messages on success or warnings on failure.
 *
 * @param filePath - Path to the file
 * @param varName - Variable name prefix (without _FILE or _CONTENT)
 * @param userVars - Object to store the populated variables
 * @param logger - Logger instance used for logging
 * @param source - String describing the origin of the file (for log messages)
 * @param absolute - Interpret filePath as absolute rather than workspace-relative
 * @returns True if the file was read successfully, false otherwise
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  userVars: Record<string, any>,
  _logger: AgentLogger,
  _source: string,
  absolute: boolean = false,
): Promise<boolean> {
  try {
    const fileContent = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.read(filePath);
    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;
    // No logging here - will be aggregated in buildUserVars
    return true;
  } catch (err) {
    // No logging here - will be aggregated in buildUserVars
    return false;
  }
}
