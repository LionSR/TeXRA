/**
 * What TeXRA offers beside an instruction notice, by the notice's key: the
 * action tokens, the label a window's button carries, the hint the CLI
 * prints in its place, and whether the notice can be silenced for good. The harness emits only the key and the message; which
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

// Frozen: the same arrays are handed to every caller, so a mutation would
// change what every later notice with that key offers.
const NO_ACTIONS: readonly InstructionAction[] = Object.freeze([]);

/** The actions beside each of the harness's notices; TeXRA's own notices
 *  (document outputs, a store moved aside) offer none. */
const ACTIONS_BY_KEY: Record<
  HarnessInstructionKey,
  readonly InstructionAction[]
> = Object.freeze({
  [HARNESS_INSTRUCTION_KEY.MISSING_API_KEY]: Object.freeze([
    INSTRUCTION_ACTION.SET_API_KEY,
    INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE,
  ]),
  [HARNESS_INSTRUCTION_KEY.MODEL_NOT_RECOGNIZED]: Object.freeze([
    INSTRUCTION_ACTION.OPEN_MODELS_DOC,
  ]),
});

function isHarnessKey(key: string): key is HarnessInstructionKey {
  return Object.hasOwn(ACTIONS_BY_KEY, key);
}

/** The actions an instruction notice with `key` offers; none for a key the
 *  table does not name. */
export function instructionActions(key: string): readonly InstructionAction[] {
  return isHarnessKey(key) ? ACTIONS_BY_KEY[key] : NO_ACTIONS;
}

/** Whether a notice with `key` offers "never remind again": the harness's
 *  name a launch that cannot run until the person acts, so they are never
 *  silenced; TeXRA's own may be. */
export function instructionSuppressible(key: string): boolean {
  return !isHarnessKey(key);
}

/** The button a window shows for each action. What the button runs is the
 *  host's: the extension binds a command, the desktop opens its settings. */
export const INSTRUCTION_ACTION_BUTTON_LABELS: Readonly<
  Record<InstructionAction, string>
> = Object.freeze({
  [INSTRUCTION_ACTION.SET_API_KEY]: 'Set API Key',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'Configuration Guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'Model Documentation',
});

/** The button beside a failure that names a guide page. */
export const READ_GUIDE_BUTTON_LABEL = 'Read the guide';

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
