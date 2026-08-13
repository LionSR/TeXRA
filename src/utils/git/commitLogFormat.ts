/**
 * Shared `git log --pretty=format` string for the "recent commits" label
 * every host renders the same way: `<shortHash>: <subject> (<relativeDate>)`.
 * Host-neutral so the VS Code extension and the Electron desktop main
 * process produce byte-identical labels from one definition.
 */
export const COMMIT_LABEL_FORMAT = '%h: %s (%cr)';

/**
 * Split `git log --pretty=format:<COMMIT_LABEL_FORMAT>` stdout into per-commit
 * label lines. Filters blank lines so a zero-commit repo (empty stdout) or a
 * trailing newline can't surface as an empty option in the commit dropdown.
 */
export function splitCommitLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
