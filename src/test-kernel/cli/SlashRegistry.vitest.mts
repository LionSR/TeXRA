// Phase 5 slash command registry + parse helpers.

import { afterEach, describe, expect, it } from 'vitest';

import {
  listSlashCommands,
  matchSlashCommands,
  parseSlashInput,
  registerSlashCommand,
  unregisterSlashCommand,
} from '../../../packages/cli/src/chat/tui/commands/slashRegistry';

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
});

describe('slashRegistry', () => {
  it('matches by name prefix case-insensitively', () => {
    registerSlashCommand({ name: 'model', description: 'pick a model' });
    registerSlashCommand({ name: 'agent', description: 'pick an agent' });
    registerSlashCommand({ name: 'merge', description: 'merge outputs' });
    expect(matchSlashCommands('m').map((c) => c.name)).toEqual([
      'model',
      'merge',
    ]);
    expect(matchSlashCommands('Mo').map((c) => c.name)).toEqual(['model']);
    expect(matchSlashCommands('').map((c) => c.name)).toEqual([
      'model',
      'agent',
      'merge',
    ]);
  });

  it('matches aliases alongside the canonical name', () => {
    registerSlashCommand({
      name: 'help',
      description: 'show help',
      aliases: ['h', 'usage'],
    });
    expect(matchSlashCommands('h').map((c) => c.name)).toEqual(['help']);
    expect(matchSlashCommands('us').map((c) => c.name)).toEqual(['help']);
  });
});

describe('parseSlashInput', () => {
  it('returns undefined for non-slash input', () => {
    expect(parseSlashInput('hello world')).toBeUndefined();
  });

  it('splits the command name from its remainder', () => {
    expect(parseSlashInput('/model anthropic claude')).toEqual({
      name: 'model',
      remainder: 'anthropic claude',
    });
    expect(parseSlashInput('/help')).toEqual({ name: 'help', remainder: '' });
    expect(parseSlashInput('/agent  reasoner')).toEqual({
      name: 'agent',
      remainder: ' reasoner',
    });
  });
});
