export const DEFAULT_GIT_AUTHOR_NAME = 'texra-ai';
export const DEFAULT_GIT_AUTHOR_EMAIL = 'texra-ai@users.noreply.github.com';

/**
 * Default for `texra.git.markCommits` when the workspace has never
 * toggled the setting. Shared by the backend reader
 * (`readGitAuthorSettings`) and the frontend signal initializer
 * (`SettingsApp.gitMarkCommits`) so the Git tab doesn't flash the
 * wrong state on first paint before settings arrive.
 */
export const DEFAULT_GIT_MARK_COMMITS = true;
