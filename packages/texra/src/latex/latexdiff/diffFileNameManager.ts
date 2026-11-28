// Standard library imports
import * as path from 'node:path';

// Local imports
import { WORKSPACE_DIFF_SUFFIX } from '@texra/common/files/fileHandlingRules';

/** The diff filename for an edited file: its stem plus
 *  {@link WORKSPACE_DIFF_SUFFIX}. */
export function generateDiffFileName(editedFile: string): string {
  return `${path.parse(editedFile).name}${WORKSPACE_DIFF_SUFFIX}.tex`;
}
