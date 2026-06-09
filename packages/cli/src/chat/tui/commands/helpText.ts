// Grouped `/help` output for the chat TUI.
//
// The transcript renders assistant text as markdown with `breaks: false`,
// so plain newline-joined lines collapse into one paragraph. Emit real
// markdown (bold section headers + list items) so each command stays on
// its own row in the transcript.

import type { SlashCommand, SlashCommandCategory } from './slashRegistry';

const CATEGORY_ORDER: readonly SlashCommandCategory[] = [
  'session',
  'configuration',
  'account',
];

const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  session: 'Session',
  configuration: 'Configuration',
  account: 'Account',
};

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
  const grouped = new Map<string, string[]>();
  for (const command of commands) {
    const label = command.category
      ? CATEGORY_LABELS[command.category]
      : 'Other';
    const items = grouped.get(label) ?? [];
    items.push(commandListItem(command));
    grouped.set(label, items);
  }

  const labels = [
    ...CATEGORY_ORDER.map((category) => CATEGORY_LABELS[category]),
    'Other',
  ];
  return labels
    .filter((label) => grouped.has(label))
    .map((label) => [`**${label}**`, ...grouped.get(label)!].join('\n'));
}

function keyboardSection(options: SlashCommandHelpOptions): string {
  const modifier = options.shortcutModifierLabel ?? 'Alt';
  const focusChord = `${modifier}${modifier === 'Esc' ? ' ' : '-'}1..9`;
  const newline =
    options.shiftEnterNewline === true
      ? '`Shift-Enter` or `Ctrl-J` insert a newline'
      : '`Ctrl-J` inserts a newline';
  return [
    '**Keyboard**',
    `- \`Enter\` sends · ${newline}`,
    '- `↑`/`↓` browse input history · `Ctrl-R` searches it',
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
