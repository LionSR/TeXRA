/**
 * Injectable git author environment variables.
 *
 * When enabled, these are merged into the environment for all commands
 * executed via {@link executeCommand}, so that any `git commit` picks up
 * the configured TeXRA author identity.
 *
 * The extension host calls {@link setGitAuthorEnv} at activation (and on
 * settings change) with values read from workspace state. This module
 * stays VS Code-free.
 */

let gitAuthorEnv: Record<string, string> = {};

/** Pass an empty object to disable injection. */
export function setGitAuthorEnv(env: Record<string, string>): void {
  gitAuthorEnv = env;
}

export function getGitAuthorEnv(): Record<string, string> {
  return gitAuthorEnv;
}
