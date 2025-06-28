// Local imports - utilities
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

export interface FileLoadResult {
  path: string;
  varName: string;
  found: boolean;
}

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
 * @returns FileLoadResult with path, varName, and found status
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  userVars: Record<string, any>,
  logger: AgentLogger,
  source: string,
  absolute: boolean = false,
): Promise<FileLoadResult> {
  try {
    const fileContent = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.readFile(filePath);
    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;
    logger.info(`[${source}] Found [VAR '${varName}']: ${filePath}`);
    return { path: filePath, varName, found: true };
  } catch (err) {
    logger.warn(`[${source}] [VAR '${varName}'] not found: ${filePath}`);
    return { path: filePath, varName, found: false };
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use setVarFromFile which now returns FileLoadResult
 */
export async function setVarFromFileLegacy(
  filePath: string,
  varName: string,
  userVars: Record<string, any>,
  logger: AgentLogger,
  source: string,
  absolute: boolean = false,
): Promise<boolean> {
  const result = await setVarFromFile(
    filePath,
    varName,
    userVars,
    logger,
    source,
    absolute,
  );
  return result.found;
}
