/**
 * Shared `git log --pretty=format` string for the "recent commits" label
 * every host renders the same way: `<shortHash>: <subject> (<relativeDate>)`.
 * Host-neutral so the VS Code extension and the Electron desktop main
 * process produce byte-identical labels from one definition.
 */
export const COMMIT_LABEL_FORMAT = '%h: %s (%cr)';
