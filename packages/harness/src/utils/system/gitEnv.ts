// Local imports
import { withExtendedPath } from './platformPaths';

/**
 * Environment keys that let git invoke arbitrary helper programs (editors,
 * pagers, askpass, external-diff, config overrides). Stripped before handing
 * the environment to a non-interactive git subprocess so an inherited value
 * can't run a helper or redirect config during automated operations.
 */
const GIT_UNSAFE_ENV_KEYS = new Set([
  'editor',
  'git_askpass',
  'git_config_global',
  'git_config_system',
  'git_config_count',
  'git_config',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_sequence_editor',
  'git_template_dir',
  'pager',
  'prefix',
  'ssh_askpass',
]);

/**
 * Build an environment for a non-interactive git subprocess: the current
 * environment with the helper-invoking keys in {@link GIT_UNSAFE_ENV_KEYS}
 * removed, `GIT_TERMINAL_PROMPT=0` so git never blocks on a tty prompt, and
 * `PATH` extended via {@link withExtendedPath} so GUI-launched hosts (whose
 * minimal PATH may omit Homebrew / /usr/local/bin, or Windows' Git\cmd when
 * git was installed for Git Bash only) can still resolve the `git` binary.
 *
 * This omits the unsafe keys rather than setting them to `undefined`, so it
 * only strips anything when it fully replaces the child environment. On a
 * ChildProcess command the env replaces the child environment unless
 * `extendEnv` is true; pass `extendEnv: false` explicitly so a later
 * `extendEnv: true` cannot merge the stripped keys back in.
 */
export function makeMachineGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !GIT_UNSAFE_ENV_KEYS.has(key.toLowerCase()),
    ),
  );
  env.GIT_TERMINAL_PROMPT = '0';
  return withExtendedPath(env);
}
