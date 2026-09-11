// Grouped /help formatting for the chat TUI.

import { afterEach, describe, expect, it } from 'vitest';

import { formatSlashCommandHelp } from '@cli/chat/tui/commands/helpText';
import {
  listSlashCommands,
  unregisterSlashCommand,
  type SlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { resetCliState } from '@cli/chat/tui/state/cliState';

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  resetCliState();
});

describe('formatSlashCommandHelp', () => {
  it('collects uncategorized commands under a trailing Other section', () => {
    const plugin: SlashCommand = {
      name: 'plugin-thing',
      description: 'A plugin command',
    };
    const help = formatSlashCommandHelp([plugin]);

    expect(help.indexOf('**Other**')).toBeGreaterThanOrEqual(0);
    expect(help).toContain('- `/plugin-thing` — A plugin command');
    expect(help.indexOf('**Other**')).toBeLessThan(
      help.indexOf('**Keyboard**'),
    );
  });

  it('adapts keyboard hints to the platform modifier and Kitty support', () => {
    const altHelp = formatSlashCommandHelp([], {
      shortcutModifierLabel: 'Alt',
      shiftEnterNewline: false,
    });
    expect(altHelp).toContain('`Alt-1..9`');
    expect(altHelp).toContain('`Ctrl-J` inserts a newline');
    expect(altHelp).not.toContain('Shift-Enter');

    const macKittyHelp = formatSlashCommandHelp([], {
      shortcutModifierLabel: 'Esc',
      shiftEnterNewline: true,
    });
    expect(macKittyHelp).toContain('`Esc 1..9`');
    expect(macKittyHelp).toContain('`Shift-Enter` or `Ctrl-J`');
    expect(macKittyHelp).toContain(
      "`Ctrl-T` opens the focused run's full output in a scrollable reader (PgUp/PgDn pages)",
    );
  });
});
