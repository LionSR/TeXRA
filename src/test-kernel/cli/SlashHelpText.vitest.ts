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
  it('groups builtin commands into ordered sections with one list item each', () => {
    registerBuiltinSlashCommands();
    const help = formatSlashCommandHelp(listSlashCommands());

    const sessionIndex = help.indexOf('**Session**');
    const configurationIndex = help.indexOf('**Configuration**');
    const accountIndex = help.indexOf('**Account**');
    const keyboardIndex = help.indexOf('**Keyboard**');
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    expect(configurationIndex).toBeGreaterThan(sessionIndex);
    expect(accountIndex).toBeGreaterThan(configurationIndex);
    expect(keyboardIndex).toBeGreaterThan(accountIndex);
    expect(help).not.toContain('**Other**');

    // Each command renders as its own markdown list item: single newlines
    // collapse in the help surface's markdown renderer, list items do not.
    expect(help).toContain('- `/clear` — Start a fresh chat session');
    expect(help).toContain(
      '- `/goal` (`/goals`) — Explain autonomous goal mode',
    );
    expect(help).toContain('- `/plan` — Read the focused session work plan');
    expect(help).toContain('- `/exit` (`/quit`) — Exit the CLI session');
    expect(help).toContain('- `/model` — Choose the model for this chat');
    expect(help).toContain('- `/models` — Enable or disable models in pickers');
    expect(help).toContain(
      '- `/key` (`/keys`) — Add a provider API key with masked input',
    );
    expect(help).toContain(
      '- `/login` — Sign in to ChatGPT for models, or Researcher Access for the hosted agent catalog',
    );
  });

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
      "`Ctrl-T` opens the focused stream's full output in a scrollable reader (PgUp/PgDn pages)",
    );
  });

  it('mentions that typing during a run queues a follow-up', () => {
    expect(formatSlashCommandHelp([])).toContain(
      'queues your message as a follow-up',
    );
  });
});
