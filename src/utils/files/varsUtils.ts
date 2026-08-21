import { createLog } from '@logger/logUtils';

import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

const log = createLog('VarsUtils');

/** A file successfully read for the `${varName}_FILE`/`${varName}_CONTENT` variable pair. */
export interface FileVarValue {
  file: string;
  content: string;
}

/**
 * Reads a file for the `${varName}_FILE`/`${varName}_CONTENT` variable pair.
 * Returns `null` on read failure; the caller decides how to name and store
 * the pair, so this stays a plain read rather than a stringly-keyed write
 * into an arbitrary vars object.
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  absolute: boolean = false,
): Promise<FileVarValue | null> {
  try {
    const content = absolute
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.read(filePath);
    return { file: filePath, content };
  } catch (error) {
    log.debug(`Failed to read ${varName} from file ${filePath}`, {
      data: error,
    });
    return null;
  }
}
