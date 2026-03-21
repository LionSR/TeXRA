/**
 * Injectable git author environment variables.
 *
 * When enabled, these are merged into the environment for all commands
 * executed via {@link executeCommand}, so that any `git commit` picks up
 * the configured TeXRA author identity.
 *
 * The extension host calls {@link setGitAuthorEnv} at activation (and on
 * config change) with values read from VS Code settings. This module
 * stays VS Code-free.
 */

let gitAuthorEnv: Record<string, string> = {};

/**
 * Set the git author environment variables to inject into executed commands.
 * Pass an empty object to disable injection.
 */
export function setGitAuthorEnv(env: Record<string, string>): void {
  gitAuthorEnv = env;
}

/** Get the current git author environment variables (may be empty). */
export function getGitAuthorEnv(): Record<string, string> {
  return gitAuthorEnv;
}
