// Standard library imports
import * as path from 'node:path';

/** The suffix a workspace diff carries after the edited file's stem. */
export const WORKSPACE_DIFF_SUFFIX = '_diff';

/** The diff filename for an edited file: its stem plus
 *  {@link WORKSPACE_DIFF_SUFFIX}. */
export function generateDiffFileName(editedFile: string): string {
  return `${path.parse(editedFile).name}${WORKSPACE_DIFF_SUFFIX}.tex`;
}
