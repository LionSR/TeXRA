import type { AgentLogger } from '@logger/AgentLogger';

import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

/**
 * Reads a file and populates user variable fields with its path and content.
 * Sets `${varName}_FILE` and `${varName}_CONTENT` in the provided userVars object.
 *
 * Note: Logger and source parameters are accepted for API compatibility but
 * logging is aggregated by callers in buildUserVars.
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  userVars: Record<string, unknown>,
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
    return true;
  } catch {
    return false;
  }
}
