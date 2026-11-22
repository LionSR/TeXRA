/**
 * How a validation script names the agent a launch starts. No command takes
 * an agent, so a script writes `--agent <name>` in the command it builds and
 * its spawn helper turns that into the validation build's variable.
 */
import { VALIDATION_AGENT } from '../src/runtime/models/validationSwitch.ts';

/** `command` without its `--agent <name>`, and the environment that names
 *  that agent (empty when the command names none). */
export function splitValidationAgent(command) {
  const at = command.indexOf('--agent');
  if (at === -1) return { command, env: {} };
  return {
    command: [...command.slice(0, at), ...command.slice(at + 2)],
    env: { [VALIDATION_AGENT]: command[at + 1] },
  };
}
