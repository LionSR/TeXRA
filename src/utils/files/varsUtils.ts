import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { AbsoluteFS } from './absoluteFS';
import { workspaceAbsolutePath } from './workspaceFS';

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
 *
 * `workspaceRoot` is the root a relative `filePath` resolves against, held by
 * the caller as data rather than read from the calling fiber's ambient roots.
 * An already-absolute `filePath` passes through it untouched, so a caller that
 * has resolved its own path can hand in `undefined`.
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  workspaceRoot: string | undefined,
): Promise<FileVarValue | null> {
  try {
    const content = await AbsoluteFS.read(
      workspaceAbsolutePath(workspaceRoot, filePath),
    );
    return { file: filePath, content };
  } catch (error) {
    // The variable is simply absent from the prompt after this, so a
    // mistyped path and a permission error must not read like a real absence.
    log.warn(
      `Failed to read ${varName} from file ${filePath}: ${toErrorMessage(error)}`,
      { data: error },
    );
    return null;
  }
}
