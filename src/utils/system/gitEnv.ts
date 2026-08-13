// Local imports
import { extendEnvPath } from './platformPaths';

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
 * removed and `PATH` extended via {@link extendEnvPath} so GUI-launched hosts
 * (whose minimal PATH may omit Homebrew / /usr/local/bin) can still resolve
 * the `git` binary.
 */
export function makeMachineGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (GIT_UNSAFE_ENV_KEYS.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  env.PATH = extendEnvPath(env.PATH);
  return env;
}
