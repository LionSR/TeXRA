import { pluralize } from '@texra-ai/harness/transcript';

import type { DiffLabel } from '@texra/hosts/uiHosts';

/** A tool edit's diff, as every host names it: the tool, the file, and how
 *  many lines it changes. */
export function toolEditDiffLabel(request: {
  readonly sourceTool: string;
  readonly relativePath: string;
  readonly addedLines: number;
  readonly removedLines: number;
}): DiffLabel {
  const { addedLines: added, removedLines: removed } = request;
  const changeParts: string[] = [];
  if (added > 0) changeParts.push(`+${added}`);
  if (removed > 0) changeParts.push(`-${removed}`);
  const changeSuffix = changeParts.length
    ? ` · ${changeParts.join(' / ')} ${pluralize(added + removed, 'line')}`
    : '';
  return {
    title: `Tool edit (${request.sourceTool}): ${request.relativePath}${changeSuffix}`,
    displayPath: request.relativePath,
  };
}

const notApplied = (relativePath: string) =>
  `Your changes to the proposed ${relativePath} were not applied: its request closed without them.`;

/**
 * What a window says when a tool edit's request closes without the changes
 * the user made to its proposed copy there: another window or the terminal
 * answered it, or a session approval or a stop decided it. The host keeps
 * the changes where the user can still reach them and names the place.
 */
export const UNAPPLIED_TOOL_EDIT = Object.freeze({
  /** Kept in an editor of their own. */
  inEditor: (relativePath: string): string =>
    `${notApplied(relativePath)} They are open in a new editor.`,
  /** Kept in the file the user's editor saved them to. */
  inFile: (relativePath: string, file: string): string =>
    `${notApplied(relativePath)} They are kept in ${file}.`,
});
