/**
 * How a validation build of the CLI is switched to its canned model
 * (`validationModel.ts`): the per-run switch, the variable naming an
 * absolute flag file and the sentinel that file holds, and each scenario's
 * switch. The model reads them; the scripts and the e2e fixture that start
 * that build set them (Node strips this file's types when a script imports
 * it).
 */

/** The per-run switch: `1` selects the canned model. */
export const VALIDATION_SWITCH = 'TEXRA_INTERNAL_VALIDATE_MODEL';
/** The variable naming the flag file; a held golden call's release file
 *  goes beside it. */
export const VALIDATION_FLAG = 'TEXRA_INTERNAL_VALIDATE_MODEL_FLAG';
/** What the flag file holds (a trailing newline is allowed). */
export const VALIDATION_FLAG_CONTENT = 'texra-cli-run-validation';
/** Each scenario's switch: `1` turns it on. */
export const VALIDATION_SCENARIOS = {
  golden: 'TEXRA_INTERNAL_VALIDATE_GOLDEN',
  echo: 'TEXRA_INTERNAL_VALIDATE_ECHO',
  scriptFanout: 'TEXRA_INTERNAL_VALIDATE_SCRIPT_FANOUT',
  historyQuery: 'TEXRA_INTERNAL_VALIDATE_HISTORY_QUERY',
} as const;
