/**
 * Trailing hint text for the {@link InstructionAction} tokens the agent core
 * attaches to an instruction.
 *
 * A host that can render each token as a button (the VS Code extension, via
 * `INSTRUCTION_ACTION_VIEW`) keeps its own command table, because the token →
 * `texra.*` command mapping is what the core must stay free of. The hosts with
 * no button to click — the CLI's stderr line and the desktop's button-less
 * dialog — render the same tokens as one parenthesized phrase appended to the
 * message, and that phrasing is the same on both except for where the user
 * goes to set a key. One rule, two styles, like
 * `formatStreamStatusLabel`.
 */

import { INSTRUCTION_ACTION, type InstructionAction } from '@shared/schemas';

// The two styles share every phrase except SET_API_KEY, so `desktop` is
// derived from `cli` rather than hand-synced.
const cliInstructionActionHints = {
  [INSTRUCTION_ACTION.SET_API_KEY]: 'set your API key (texra setup)',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'see the configuration guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'see the model documentation',
} as const satisfies Record<InstructionAction, string>;

const INSTRUCTION_ACTION_HINTS = {
  cli: cliInstructionActionHints,
  desktop: {
    ...cliInstructionActionHints,
    [INSTRUCTION_ACTION.SET_API_KEY]: 'set your API key in Settings',
  },
} as const;

type InstructionActionHintStyle = keyof typeof INSTRUCTION_ACTION_HINTS;

/**
 * The ` (hint, hint)` suffix for an instruction's action tokens, or `''` when
 * it carries none. The lookup stays partial: a token from a newer producer can
 * arrive over the wire, and those fall back to the raw token rather than
 * dropping out of the sentence.
 */
export function formatInstructionActionHint(
  actions: readonly InstructionAction[] | undefined,
  style: InstructionActionHintStyle,
): string {
  if (!actions?.length) return '';
  const hints: Partial<Record<InstructionAction, string>> =
    INSTRUCTION_ACTION_HINTS[style];
  return ` (${actions.map((action) => hints[action] ?? action).join(', ')})`;
}
