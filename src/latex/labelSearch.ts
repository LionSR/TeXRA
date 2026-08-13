// Local imports - utilities
import escapeRegExp from 'escape-string-regexp';

/** Build a regex matching `\label{<label>}` for a literal label string. */
function buildLabelPattern(label: string): RegExp {
  return new RegExp(`\\\\label\\{${escapeRegExp(label)}\\}`, 'm');
}

/**
 * Scan candidate files for `\label{<label>}` and hand the first match to
 * `onMatch(file, index)`, where `index` is the character offset of the match
 * (so editors can reveal the label position).
 *
 * Reading a candidate and handling its match both run inside the scan: if
 * `read` or `onMatch` throws, the failure is swallowed and scanning continues
 * to the next candidate. This lets a transient read/open failure on one match
 * fall through to another file that contains the same label. Returns `true`
 * once a match has been handled, `false` if no candidate matched (or every
 * matching candidate failed to handle).
 *
 * Host-neutral: callers supply their own file lister, reader, and open
 * handler, so the VS Code command and the desktop bridge share one scan.
 */
export async function openFirstLabelMatch(
  label: string,
  files: Iterable<string>,
  read: (file: string) => Promise<string>,
  onMatch: (file: string, index: number) => Promise<void>,
): Promise<boolean> {
  const pattern = buildLabelPattern(label);
  for (const file of files) {
    try {
      const content = await read(file);
      const match = content.match(pattern);
      if (match && match.index !== undefined) {
        await onMatch(file, match.index);
        return true;
      }
    } catch {
      // Skip unreadable candidates / failed opens and keep scanning.
    }
  }
  return false;
}
