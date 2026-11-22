/**
 * How a validation script names the run a launch starts. No command takes
 * one, so a script writes `--agent <run>` in the command it builds, `<run>`
 * the `{ label, system, tools }` it starts (a `ValidationAgent`, written
 * inline or taken from `GOLDEN_AGENTS`), and its spawn helper turns that into
 * the validation build's variable.
 */
import { VALIDATION_AGENT } from '../src/runtime/models/validationSwitch.ts';

/** `command` without its `--agent <run>`, and the environment that writes
 *  that run (empty when the command names none). */
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
