/**
 * What the validation scripts share about the validation build of the CLI:
 * how it is built, the provider keys its child processes are given, where a
 * launch's project store is, and how a script names the run a launch starts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { VALIDATION_AGENT } from '../src/runtime/models/validationSwitch.ts';

/** The key a validation child holds for a provider: no request leaves the
 *  canned model, so it only has to be present. */
export const VALIDATION_FAKE_API_KEY = 'texra-validation-fake-key';

/** Every provider key variable a child could inherit from the caller. */
export const VALIDATION_PROVIDER_KEYS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'MINIMAX_API_KEY',
  'GLM_API_KEY',
]);

/**
 * Build the CLI with the canned model at `binaryPath` (`<root>/bin/texra.js`)
 * and its resources at `<root>/resources`.
 */
export function buildValidationCli(binaryPath) {
  const root = path.dirname(path.dirname(binaryPath));
  for (const [script, env] of [
    [
      'bundle',
      {
        TEXRA_CLI_BUNDLE_OUTFILE: binaryPath,
        TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
      },
    ],
    [
      'copy:resources',
      { TEXRA_CLI_RESOURCES_OUTDIR: path.join(root, 'resources') },
    ],
  ]) {
    const result = spawnSync('pnpm', ['run', script], {
      cwd: path.dirname(import.meta.dirname),
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`pnpm run ${script} failed`);
  }
}

/**
 * The directory of the project store under the TeXRA data root `dataRoot`
 * whose name starts with `prefix`, or undefined until a session has made
 * it. A service also keeps a no-workspace store beside it, which holds no
 * runs.
 */
export function projectStore(dataRoot, prefix = 'work-') {
  const storage = path.join(dataRoot, 'v1', 'workspace-storage');
  if (!existsSync(storage)) return undefined;
  const name = readdirSync(storage).find((entry) => entry.startsWith(prefix));
  return name === undefined ? undefined : path.join(storage, name);
}

/**
 * `command` without its `--agent <run>`, and the environment that writes
 * that run (empty when the command names none). No command takes a run, so
 * a script writes `--agent <run>` in the command it builds, `<run>` the
 * `{ label, system, tools }` it starts (a `ValidationAgent`, written inline
 * or taken from `GOLDEN_AGENTS`).
 */
export function splitValidationAgent(command) {
  const at = command.indexOf('--agent');
  if (at === -1) return { command, env: {} };
  const run = command[at + 1];
  if (typeof run !== 'object' || run === null)
    throw new Error(
      `--agent takes a { label, system, tools } object, got ${run}`,
    );
  return {
    command: [...command.slice(0, at), ...command.slice(at + 2)],
    env: { [VALIDATION_AGENT]: JSON.stringify(run) },
  };
}
