/**
 * What TeXRA offers beside an instruction notice, by the notice's key: the
 * action tokens each host renders its own way (the VS Code extension as
 * buttons bound to commands, the desktop as dialog buttons, the CLI as a
 * trailing hint). The harness emits only the key and the message; which
 * affordances a key gets is the application's to say, here, once.
 */

import {
  HARNESS_INSTRUCTION_KEY,
  type HarnessInstructionKey,
} from '@texra-ai/harness/schemas';

/** Host-agnostic action tokens; each host maps a token to its own UI. */
export const INSTRUCTION_ACTION = {
  SET_API_KEY: 'set-api-key',
  OPEN_CONFIGURATION_GUIDE: 'open-configuration-guide',
  OPEN_MODELS_DOC: 'open-models-doc',
} as const;

export type InstructionAction =
  (typeof INSTRUCTION_ACTION)[keyof typeof INSTRUCTION_ACTION];

const NO_ACTIONS: readonly InstructionAction[] = [];

/** The actions beside each of the harness's notices; TeXRA's own notices
 *  (document outputs, a store moved aside) offer none. */
const ACTIONS_BY_KEY: Record<
  HarnessInstructionKey,
  readonly InstructionAction[]
> = {
  [HARNESS_INSTRUCTION_KEY.MISSING_API_KEY]: [
    INSTRUCTION_ACTION.SET_API_KEY,
    INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE,
  ],
  [HARNESS_INSTRUCTION_KEY.MODEL_NOT_RECOGNIZED]: [
    INSTRUCTION_ACTION.OPEN_MODELS_DOC,
  ],
  [HARNESS_INSTRUCTION_KEY.RESUME_REFUSED]: NO_ACTIONS,
};

function isHarnessKey(key: string): key is HarnessInstructionKey {
  return Object.hasOwn(ACTIONS_BY_KEY, key);
}

/** The actions an instruction notice with `key` offers; none for a key the
 *  table does not name. */
export function instructionActions(key: string): readonly InstructionAction[] {
  return isHarnessKey(key) ? ACTIONS_BY_KEY[key] : NO_ACTIONS;
}

const CLI_INSTRUCTION_ACTION_HINTS: Record<InstructionAction, string> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: 'set your API key (texra setup)',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'see the configuration guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'see the model documentation',
};

/** The ` (hint, hint)` suffix the CLI appends for `actions`, or `''` when
 *  there are none: its stderr line has no button to click. */
export function formatInstructionActionHint(
  actions: readonly InstructionAction[],
): string {
  if (actions.length === 0) return '';
  return ` (${actions.map((action) => CLI_INSTRUCTION_ACTION_HINTS[action]).join(', ')})`;
}
