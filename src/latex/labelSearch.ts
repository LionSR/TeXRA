// Local imports - utilities
import { escapeRegExp } from '@utils/core/stringCore';

/** Build a regex matching `\label{<label>}` for a literal label string. */
export function buildLabelPattern(label: string): RegExp {
  return new RegExp(`\\\\label\\{${escapeRegExp(label)}\\}`, 'm');
}

/**
 * Scan candidate files for `\label{<label>}` and return the first match's file
 * and character offset within that file.
 *
 * `read` returns a candidate's content or throws; unreadable candidates are
 * skipped. Host-neutral so the VS Code command and the desktop bridge share
 * one scan: callers supply their own file lister and reader and decide how to
 * open the returned file (the offset lets editors reveal the label position).
 */
export async function findLabelLocation(
  label: string,
  files: Iterable<string>,
  read: (file: string) => Promise<string>,
): Promise<{ file: string; index: number } | undefined> {
  const pattern = buildLabelPattern(label);
  for (const file of files) {
    try {
      const content = await read(file);
      const match = content.match(pattern);
      if (match && match.index !== undefined) {
        return { file, index: match.index };
      }
    } catch {
      // Skip unreadable candidates and keep scanning.
    }
  }
  return undefined;
}
