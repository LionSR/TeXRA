/**
 * Shared line-formatting for the /files and /workspace-files listing
 * endpoints. Both render the same right-aligned "<size>  <path>" shape
 * (`<dir>` for directories); callers normalize their own entry shape to
 * `SizedEntry` before calling in, since `listFiles` and `listWorkspaceFiles`
 * source entries with differently-named directory flags.
 */

import { formatBytes } from '@utils/text/stringUtils';

export interface SizedEntry {
  readonly path: string;
  readonly size: number;
  readonly isDir: boolean;
}

/** Format entries as right-aligned size + path lines. */
export function formatSizedEntryLines(
  entries: readonly SizedEntry[],
): string[] {
  return entries.map((entry) => {
    const sizeStr = entry.isDir ? '<dir>' : formatBytes(entry.size);
    return `${sizeStr.padStart(8)}  ${entry.path}`;
  });
}
