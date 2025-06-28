// Local imports - utilities
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - input status collection
import { getInputStatusCollector } from '@agent/utils/InputStatusCollector';

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
  logger: AgentLogger,
  source: string,
  absolute: boolean = false,
): Promise<boolean> {
  try {
    const fileContent = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.readFile(filePath);

    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;

    // Record successful file loading
    getInputStatusCollector().recordRequiredFile(
      filePath,
      varName,
      true,
      absolute,
    );

    logger.info(`[${source}] Found [VAR '${varName}']: ${filePath}`);
    return true;
  } catch (err) {
    // Record failed file loading
    getInputStatusCollector().recordRequiredFile(
      filePath,
      varName,
      false,
      absolute,
    );

    logger.warn(`[${source}] [VAR '${varName}'] not found: ${filePath}`);
    return false;
  }
}
