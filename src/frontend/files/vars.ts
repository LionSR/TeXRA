// Local imports - utilities
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - progress view
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

/**
 * Interface for file status updates
 */
export interface FileStatusUpdate {
  variable: string;
  filePath: string;
  source: string;
  found: boolean;
  patternName?: string;
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
 * @param fileStatusUpdates - Optional array to collect file status updates for progress view
 * @param patternName - Optional pattern name for pattern-based file matching
 * @returns True if the file was read successfully, false otherwise
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  userVars: Record<string, any>,
  logger: AgentLogger,
  source: string,
  absolute: boolean = false,
  fileStatusUpdates?: FileStatusUpdate[],
  patternName?: string,
): Promise<boolean> {
  try {
    const fileContent = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.readFile(filePath);
    userVars[`${varName}_FILE`] = filePath;
    userVars[`${varName}_CONTENT`] = fileContent;
    logger.info(`[${source}] Found [VAR '${varName}']: ${filePath}`);
    
    // Collect file status update for progress view
    if (fileStatusUpdates) {
      fileStatusUpdates.push({
        variable: varName,
        filePath,
        source,
        found: true,
        patternName,
      });
    }
    
    return true;
  } catch (err) {
    logger.warn(`[${source}] [VAR '${varName}'] not found: ${filePath}`);
    
    // Collect file status update for progress view
    if (fileStatusUpdates) {
      fileStatusUpdates.push({
        variable: varName,
        filePath,
        source,
        found: false,
        patternName,
      });
    }
    
    return false;
  }
}
