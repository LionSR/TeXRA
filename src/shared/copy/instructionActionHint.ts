/**
 * Trailing hint text for the {@link InstructionAction} tokens the agent core
 * attaches to an instruction.
 *
 * A host that can render each token as a button (the VS Code extension's
 * `INSTRUCTION_ACTION_VIEW`, or desktop's `showInstructionDialog`) keeps its
 * own command table, because the token → command mapping is what the core
 * must stay free of. The CLI has no button to click — its stderr line renders
 * the same tokens as one parenthesized phrase appended to the message.
 */

import { INSTRUCTION_ACTION, type InstructionAction } from '@shared/schemas';

const CLI_INSTRUCTION_ACTION_HINTS = {
  [INSTRUCTION_ACTION.SET_API_KEY]: 'set your API key (texra setup)',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'see the configuration guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'see the model documentation',
} as const satisfies Record<InstructionAction, string>;

/**
 * The ` (hint, hint)` suffix for an instruction's action tokens, or `''` when
 * it carries none. The lookup stays partial: a token from a newer producer can
 * arrive over the wire, and those fall back to the raw token rather than
 * dropping out of the sentence.
 */
export function formatInstructionActionHint(
  actions: readonly InstructionAction[] | undefined,
): string {
  if (!actions?.length) return '';
  return ` (${actions.map((action) => CLI_INSTRUCTION_ACTION_HINTS[action] ?? action).join(', ')})`;
}
