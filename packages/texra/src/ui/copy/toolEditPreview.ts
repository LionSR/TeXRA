const notApplied = (relativePath: string) =>
  `Your changes to the proposed ${relativePath} were not applied: its request closed without them.`;

/**
 * What a window says when a tool edit's request closes without the changes
 * the user made to its proposed copy there: another window or the terminal
 * answered it, or a session approval or a stop decided it. The host keeps
 * the changes where the user can still reach them and names the place.
 */
export const UNAPPLIED_TOOL_EDIT = {
  /** Kept in an editor of their own. */
  inEditor: (relativePath: string): string =>
    `${notApplied(relativePath)} They are open in a new editor.`,
  /** Kept in the file the user's editor saved them to. */
  inFile: (relativePath: string, file: string): string =>
    `${notApplied(relativePath)} They are kept in ${file}.`,
} as const;
