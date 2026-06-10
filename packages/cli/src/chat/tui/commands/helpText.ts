// Grouped `/help` output for the chat TUI.
//
// The transcript renders assistant text as markdown with `breaks: false`,
// so plain newline-joined lines collapse into one paragraph. Emit real
// markdown (bold section headers + list items) so each command stays on
// its own row in the transcript.

import { textInputEditingHelp } from '../input/textInputBindings';
import { metaChordLabel } from '../panes/StatusBar';

import type { SlashCommand, SlashCommandCategory } from './slashRegistry';

// Help sections in display order; `undefined` collects uncategorized
// (plugin-style) registrations into a trailing "Other" section.
const CATEGORY_SECTIONS: ReadonlyArray<{
  readonly category: SlashCommandCategory | undefined;
  readonly label: string;
}> = [
  { category: 'session', label: 'Session' },
  { category: 'configuration', label: 'Configuration' },
  { category: 'account', label: 'Account' },
  { category: undefined, label: 'Other' },
];

export interface SlashCommandHelpOptions {
  /** Chord modifier shown for stream-focus shortcuts: `Alt` on most
   *  platforms, `Esc` on macOS (see `defaultShortcutModifierLabel`). */
  readonly shortcutModifierLabel?: string;
  /** Advertise Shift+Enter for newline when the Kitty keyboard protocol is
   *  active; Ctrl-J is the universal fallback. */
  readonly shiftEnterNewline?: boolean;
}

function commandListItem(command: SlashCommand): string {
  const aliases = (command.aliases ?? [])
    .map((alias) => ` (\`/${alias}\`)`)
    .join('');
  return `- \`/${command.name}\`${aliases} — ${command.description}`;
}

function commandSections(commands: readonly SlashCommand[]): string[] {
  return CATEGORY_SECTIONS.flatMap(({ category, label }) => {
    const items = commands.filter((command) => command.category === category);
    return items.length === 0
      ? []
      : [[`**${label}**`, ...items.map(commandListItem)].join('\n')];
  });
}

function keyboardSection(options: SlashCommandHelpOptions): string {
  const focusChord = metaChordLabel(
    options.shortcutModifierLabel ?? 'Alt',
    '1..9',
  );
  const newline =
    options.shiftEnterNewline === true
      ? '`Shift-Enter` or `Ctrl-J` insert a newline'
      : '`Ctrl-J` inserts a newline';
  return [
    '**Keyboard**',
    `- \`Enter\` sends · ${newline}`,
    '- `↑`/`↓` browse input history · `Ctrl-R` searches it',
    // Generated from the editing keymap so this list can't drift from the
    // bindings that actually exist (see textInputBindings.ts).
    `- ${textInputEditingHelp()}`,
    '- `Esc` stops the current response · `Ctrl-C` stops, twice exits',
    '- `Ctrl-T` opens the transcript viewer for the focused stream',
    `- \`Tab\` switches streams · \`${focusChord}\` jumps to one (when subagents are running)`,
  ].join('\n');
}

export function formatSlashCommandHelp(
  commands: readonly SlashCommand[],
  options: SlashCommandHelpOptions = {},
): string {
  return [
    ...commandSections(commands),
    keyboardSection(options),
    'Typing while a response is running queues your message as a follow-up.',
  ].join('\n\n');
}
