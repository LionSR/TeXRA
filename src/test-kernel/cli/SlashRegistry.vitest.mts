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
import { openRegisteredCliSlashForm } from '@cli/chat/tui/runChatTui';
import { cliState, resetCliState } from '@cli/chat/tui/state/cliState';
import type { CliApiMode } from '@cli/runtime/apiAccessMode';

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  resetCliState();
});

describe('slashRegistry', () => {
  function renderFormAdapter<TProps>(node: unknown): { props?: TProps } {
    const element = node as {
      type?: (props: unknown) => unknown;
      props?: unknown;
    };
    if (typeof element.type !== 'function') {
      throw new TypeError('Expected registered slash form adapter element');
    }
    return element.type(element.props) as { props?: TProps };
  }

  async function settleFormSelection(): Promise<void> {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
  }

  function deferredSelection(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  } {
    let resolveSelection: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveSelection = resolve;
    });
    return { promise, resolve: resolveSelection };
  }

  function renderOpenForm<TProps>(): {
    readonly props?: TProps;
    readonly isClosed: () => boolean;
  } {
    let closed = false;
    const node = renderFormAdapter<TProps>(
      cliState.activeForm.get()?.render(() => {
        closed = true;
      }, 20),
    );
    return {
      props: node.props,
      isClosed: () => closed,
    };
  }

  it('keeps the CLI session control commands registered', () => {
    registerBuiltinSlashCommands();
    expect(listSlashCommands().map((cmd) => cmd.name)).toEqual(
      expect.arrayContaining([
        'agent',
        'model',
        'api',
        'auth',
        'login',
        'logout',
        'approval',
        'yolo',
        'status',
        'resume',
        'memory',
        'skills',
        'tools',
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
    expect(listSlashCommands().find((cmd) => cmd.name === 'tools')).toEqual(
      expect.objectContaining({
        description: 'List or toggle external integrations',
        formComponent: expect.any(Function),
      }),
    );
    expect(listSlashCommands().find((cmd) => cmd.name === 'skills')).toEqual(
      expect.objectContaining({
        description: 'List available skills',
        aliases: ['skill'],
        formComponent: expect.any(Function),
      }),
    );
    expect(listSlashCommands().find((cmd) => cmd.name === 'compact')).toEqual(
      expect.objectContaining({
        description: 'Request context compaction',
      }),
    );
  });

  it('opens registered structured forms through the shared form opener', () => {
    registerBuiltinSlashCommands();
    const tools = listSlashCommands().find((cmd) => cmd.name === 'tools');

    if (!tools) throw new Error('Expected /tools to be registered');

    expect(openRegisteredCliSlashForm(tools, '')).toBe(true);
    expect(cliState.activeForm.get()?.commandName).toBe('tools');
  });

  it('chains selectable agent picks into the API-mode-aware model picker', async () => {
    resetCliState({
      agent: 'chat',
      model: 'deepseekT',
      cwd: '/tmp/workspace',
      apiMode: 'included',
      canDelegate: false,
      version: 'test',
    });
    registerBuiltinSlashCommands();
    const agent = listSlashCommands().find((cmd) => cmd.name === 'agent');

    if (!agent) throw new Error('Expected /agent to be registered');

    expect(openRegisteredCliSlashForm(agent, '')).toBe(true);

    const agentNode = renderFormAdapter<{
      onSelect?: (value: string) => void;
    }>(cliState.activeForm.get()?.render(() => {}, 20));
    agentNode.props?.onSelect?.('review');
    await settleFormSelection();

    expect(cliState.sessionMeta.get().agent).toBe('review');
    expect(cliState.activeForm.get()?.commandName).toBe('model');

    const modelNode = renderFormAdapter<{
      apiMode?: string;
      selectable?: boolean;
    }>(cliState.activeForm.get()?.render(() => {}, 20));
    expect(modelNode.props).toMatchObject({
      apiMode: 'included',
      selectable: true,
    });
  });

  it('marks the agent picker read-only when root selection is closed', () => {
    resetCliState({
      agent: 'chat',
      model: 'deepseekT',
      cwd: '/tmp/workspace',
      apiMode: 'included',
      canDelegate: false,
      version: 'test',
    });
    registerBuiltinSlashCommands({
      canSelectAgent: () => false,
      canSelectModel: () => true,
    });
    const agent = listSlashCommands().find((cmd) => cmd.name === 'agent');

    if (!agent) throw new Error('Expected /agent to be registered');

    expect(openRegisteredCliSlashForm(agent, '')).toBe(true);

    const agentNode = renderFormAdapter<{
      selectable?: boolean;
    }>(cliState.activeForm.get()?.render(() => {}, 20));

    expect(agentNode.props).toMatchObject({ selectable: false });
    expect(cliState.activeForm.get()?.commandName).toBe('agent');
  });

  it('keeps the model picker selectable after root agent selection is closed', () => {
    resetCliState({
      agent: 'chat',
      model: 'deepseekT',
      cwd: '/tmp/workspace',
      apiMode: 'included',
      canDelegate: false,
      version: 'test',
    });
    registerBuiltinSlashCommands({
      canSelectAgent: () => false,
      canSelectModel: () => true,
    });
    const model = listSlashCommands().find((cmd) => cmd.name === 'model');

    if (!model) throw new Error('Expected /model to be registered');

    expect(openRegisteredCliSlashForm(model, '')).toBe(true);

    const modelNode = renderFormAdapter<{
      selectable?: boolean;
    }>(cliState.activeForm.get()?.render(() => {}, 20));

    expect(modelNode.props).toMatchObject({ selectable: true });
  });

  it('passes live model-switch disabled reasons into the model picker', () => {
    resetCliState({
      agent: 'chat',
      model: 'gpt54',
      cwd: '/tmp/workspace',
      apiMode: 'personal',
      canDelegate: false,
      version: 'test',
    });
    registerBuiltinSlashCommands({
      canSelectModel: () => true,
      getModelSwitchDisabledReason: (model) =>
        model === 'sonnet46T'
          ? 'different conversation format; start new chat'
          : undefined,
    });
    const model = listSlashCommands().find((cmd) => cmd.name === 'model');

    if (!model) throw new Error('Expected /model to be registered');

    expect(openRegisteredCliSlashForm(model, '')).toBe(true);

    const modelNode = renderFormAdapter<{
      getModelSwitchDisabledReason?: (model: string) => string | undefined;
    }>(cliState.activeForm.get()?.render(() => {}, 20));

    expect(modelNode.props?.getModelSwitchDisabledReason?.('sonnet46T')).toBe(
      'different conversation format; start new chat',
    );
    expect(modelNode.props?.getModelSwitchDisabledReason?.('gpt55')).toBe(
      undefined,
    );
  });

  it('keeps the model picker open until model selection commits', async () => {
    const selection = deferredSelection();
    registerBuiltinSlashCommands({
      onModelSelect: () => selection.promise,
    });
    const model = listSlashCommands().find((cmd) => cmd.name === 'model');

    if (!model) throw new Error('Expected /model to be registered');

    expect(openRegisteredCliSlashForm(model, '')).toBe(true);

    const modelNode = renderOpenForm<{
      onSelect?: (value: string) => void;
    }>();
    modelNode.props?.onSelect?.('gpt55');
    await settleFormSelection();

    expect(modelNode.isClosed()).toBe(false);

    selection.resolve();
    await settleFormSelection();

    expect(modelNode.isClosed()).toBe(true);
  });

  it('routes model picker selection failures to the shared error handler', async () => {
    const errors: string[] = [];
    registerBuiltinSlashCommands({
      onModelSelect: async () => {
        throw new Error('model failed');
      },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });
    const model = listSlashCommands().find((cmd) => cmd.name === 'model');

    if (!model) throw new Error('Expected /model to be registered');

    expect(openRegisteredCliSlashForm(model, '')).toBe(true);

    const modelNode = renderOpenForm<{
      onSelect?: (value: string) => void;
    }>();
    modelNode.props?.onSelect?.('gpt55');
    await settleFormSelection();

    expect(errors).toEqual(['model failed']);
    expect(modelNode.isClosed()).toBe(true);
  });

  it('routes API picker selection failures to the shared error handler', async () => {
    resetCliState({
      agent: 'chat',
      model: 'deepseekT',
      cwd: '/tmp/workspace',
      apiMode: 'included',
      canDelegate: false,
      version: 'test',
    });
    const errors: string[] = [];
    registerBuiltinSlashCommands({
      onApiModeSelect: async () => {
        throw new Error('api mode failed');
      },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });
    const api = listSlashCommands().find((cmd) => cmd.name === 'api');

    if (!api) throw new Error('Expected /api to be registered');

    expect(openRegisteredCliSlashForm(api, '')).toBe(true);

    const apiNode = renderOpenForm<{
      onSelect?: (value: CliApiMode) => void;
    }>();
    apiNode.props?.onSelect?.('personal');
    await settleFormSelection();

    expect(errors).toEqual(['api mode failed']);
    expect(apiNode.isClosed()).toBe(true);
  });

  it('keeps the API picker open until API mode selection commits', async () => {
    resetCliState({
      agent: 'chat',
      model: 'deepseekT',
      cwd: '/tmp/workspace',
      apiMode: 'included',
      canDelegate: false,
      version: 'test',
    });
    const selection = deferredSelection();
    registerBuiltinSlashCommands({
      onApiModeSelect: () => selection.promise,
    });
    const api = listSlashCommands().find((cmd) => cmd.name === 'api');

    if (!api) throw new Error('Expected /api to be registered');

    expect(openRegisteredCliSlashForm(api, '')).toBe(true);

    const apiNode = renderOpenForm<{
      onSelect?: (value: CliApiMode) => void;
    }>();
    apiNode.props?.onSelect?.('personal');
    await settleFormSelection();

    expect(apiNode.isClosed()).toBe(false);

    selection.resolve();
    await settleFormSelection();

    expect(apiNode.isClosed()).toBe(true);
  });

  it('closes the resume picker before running the resume action', async () => {
    let closed = false;
    let sawClosedBeforeResume = false;
    registerBuiltinSlashCommands({
      onResumeSelect: async () => {
        sawClosedBeforeResume = closed;
      },
    });
    const resume = listSlashCommands().find((cmd) => cmd.name === 'resume');

    if (!resume) throw new Error('Expected /resume to be registered');

    expect(openRegisteredCliSlashForm(resume, '')).toBe(true);

    const resumeNode = renderFormAdapter<{
      onSelect?: (id: string) => void;
    }>(
      cliState.activeForm.get()?.render(() => {
        closed = true;
      }, 20),
    );
    resumeNode.props?.onSelect?.('previous-session');
    await settleFormSelection();

    expect(closed).toBe(true);
    expect(sawClosedBeforeResume).toBe(true);
  });

  it('routes skill picker selections through the shared handler', async () => {
    const selected: string[] = [];
    let closed = false;
    let sawClosedBeforeSkillSelect = false;
    registerBuiltinSlashCommands({
      onSkillSelect: (value) => {
        sawClosedBeforeSkillSelect = closed;
        selected.push(value.activationPrompt);
      },
    });
    const skills = listSlashCommands().find((cmd) => cmd.name === 'skills');

    if (!skills) throw new Error('Expected /skills to be registered');

    expect(openRegisteredCliSlashForm(skills, '')).toBe(true);

    const skillsNode = renderFormAdapter<{
      onSelect?: (value: {
        readonly name: string;
        readonly activationPrompt: string;
      }) => void;
    }>(
      cliState.activeForm.get()?.render(() => {
        closed = true;
      }, 20),
    );
    skillsNode.props?.onSelect?.({
      name: 'proof-audit',
      activationPrompt: '<skill_activation>proof-audit</skill_activation>',
    });
    await settleFormSelection();

    expect(selected).toEqual([
      '<skill_activation>proof-audit</skill_activation>',
    ]);
    expect(closed).toBe(true);
    expect(sawClosedBeforeSkillSelect).toBe(true);
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
