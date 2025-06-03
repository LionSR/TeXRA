// Local imports - utilities
import * as fs from 'fs/promises';
import { readFile } from './workspaceFileUtils';
import { AgentLogger } from '../logger/AgentLogger';

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
      ? await fs.readFile(filePath, 'utf-8')
      : await readFile(filePath);
    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;
    logger.info(`Found from [${source}] the [VAR '${varName}']: ${filePath}`);
    return true;
  } catch (err) {
    logger.warn(`[${source}] ${filePath} not found from [VAR '${varName}'].`);
    return false;
  }
}
