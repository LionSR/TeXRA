// Slash command registry and parse helpers.

import { afterEach, describe, expect, it } from 'vitest';

import {
  listSlashCommands,
  matchSlashCommands,
  parseSlashInput,
  registerSlashCommand,
  slashPickIntent,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
});

describe('slashRegistry', () => {
  it('keeps the CLI session control commands registered', () => {
    registerBuiltinSlashCommands();
    expect(listSlashCommands().map((cmd) => cmd.name)).toEqual(
      expect.arrayContaining([
        'agent',
        'model',
        'api',
        'auth',
        'approval',
        'yolo',
        'status',
        'resume',
        'memory',
        'compact',
      ]),
    );
    expect(
      listSlashCommands().find((cmd) => cmd.name === 'model'),
    ).toMatchObject({
      description: 'List available models',
    });
    expect(listSlashCommands().find((cmd) => cmd.name === 'agent')).toEqual(
      expect.objectContaining({
        description: 'List or choose the root agent',
        formComponent: expect.any(Function),
      }),
    );
    expect(listSlashCommands().find((cmd) => cmd.name === 'approval')).toEqual(
      expect.objectContaining({
        description: 'Switch approval policy',
        formComponent: expect.any(Function),
      }),
    );
    expect(listSlashCommands().find((cmd) => cmd.name === 'memory')).toEqual(
      expect.objectContaining({
        description: 'List stored memories',
        formComponent: expect.any(Function),
      }),
    );
    expect(listSlashCommands().find((cmd) => cmd.name === 'resume')).toEqual(
      expect.objectContaining({
        description: 'Resume a previous session',
        formComponent: expect.any(Function),
      }),
    );
    expect(listSlashCommands().find((cmd) => cmd.name === 'compact')).toEqual(
      expect.objectContaining({
        description: 'Request context compaction',
      }),
    );
  });

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

  it('submits no-form commands on Enter and completes on Tab', () => {
    const help = { name: 'help', description: 'show help', aliases: ['h'] };
    registerSlashCommand(help);

    expect(slashPickIntent(help, 'enter')).toBe('submit');
    expect(slashPickIntent(help, 'tab')).toBe('complete');
  });

  it('completes arg-taking commands on Enter so the user can type the argument', () => {
    const foo = { name: 'foo', description: 'takes args', takesArgs: true };
    registerSlashCommand(foo);

    expect(slashPickIntent(foo, 'enter')).toBe('complete');
    expect(slashPickIntent(foo, 'tab')).toBe('complete');
  });

  it('does not directly submit structured-form commands from the palette', () => {
    const agent = {
      name: 'agent',
      description: 'pick an agent',
      formComponent: () => null,
    };
    registerSlashCommand(agent);

    expect(slashPickIntent(agent, 'enter')).toBe('complete');
  });
});

describe('parseSlashInput', () => {
  it('returns undefined for non-slash input', () => {
    expect(parseSlashInput('hello world')).toBeUndefined();
  });

  it('accepts the historical clear spelling without treating TeX as commands', () => {
    expect(parseSlashInput('\\clear')).toEqual({
      name: 'clear',
      remainder: '',
    });
    expect(parseSlashInput('\\alpha + \\beta')).toBeUndefined();
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
