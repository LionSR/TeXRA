import { joinFacts } from '@texra-ai/harness/schemas';
import type { DiffLabel } from '@texra/hosts/uiHosts';
import { formatLineChanges } from '@ui/copy/format';

/** A tool edit's diff, as every host names it: the tool, the file, and how
 *  many lines it changes. */
export function toolEditDiffLabel(request: {
  readonly sourceTool: string;
  readonly relativePath: string;
  readonly addedLines: number;
  readonly removedLines: number;
}): DiffLabel {
  const { addedLines: added, removedLines: removed } = request;
  return {
    title: joinFacts([
      `Tool edit (${request.sourceTool}): ${request.relativePath}`,
      added + removed > 0 && formatLineChanges(added, removed),
    ]),
    displayPath: request.relativePath,
  };
}

/** Where a tool edit's diff cannot be shown: why, in the host's words. */
export const previewUnavailable = (reason: string): string =>
  `Preview unavailable: ${reason}`;

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
