// Slash command registry and parse helpers.

import { afterEach, describe, expect, it } from 'vitest';

import {
  findSlashCommand,
  listSlashCommands,
  matchSlashCommands,
  parseSlashInput,
  prefixSlashCommands,
  registerSlashCommand,
  slashPickIntent,
  suggestSlashCommand,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import {
  openCliSlashCommandForm,
  openRegisteredCliSlashForm,
} from '@cli/chat/tui/commands/slashForms';
import { LOGIN_FORM_ITEMS } from '@cli/chat/tui/forms/LoginForm';
import {
  activeForm,
  resetCliState,
  sessionMeta,
  type SessionMeta,
} from '@cli/chat/tui/state/cliState';
import type { CliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { AgentCategory } from '@shared/schemas/agent';
import { toErrorMessage } from '@utils/errors/errorMessage';

const INCLUDED_CHAT_SESSION: SessionMeta = {
  agent: 'chat',
  category: AgentCategory.ToolUse,
  model: 'deepseekT',
  modelSource: 'builtin-default',
  cwd: '/tmp/workspace',
  apiMode: 'included',
  approvalPolicy: 'ask',
  canDelegate: false,
  transcriptMode: 'persistent',
  version: 'test',
};

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
      activeForm.get()?.render(() => {
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
        'key',
        'auth',
        'login',
        'logout',
        'approval',
        'yolo',
        'status',
        'goal',
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
    expect(listSlashCommands().find((cmd) => cmd.name === 'login')).toEqual(
      expect.objectContaining({
        description: 'Sign in to ChatGPT or Researcher Access',
        formComponent: expect.any(Function),
      }),
    );
    expect(listSlashCommands().find((cmd) => cmd.name === 'compact')).toEqual(
      expect.objectContaining({
        description: 'Request context compaction',
      }),
    );
  });

  it('keeps ChatGPT subscription first in the login picker', () => {
    expect(LOGIN_FORM_ITEMS.map((item) => item.value)).toEqual([
      'chatgpt',
      'texra',
      'chatgpt --device',
      'texra --device',
    ]);
  });

  it('opens registered structured forms through the shared form opener', () => {
    registerBuiltinSlashCommands();
    const tools = listSlashCommands().find((cmd) => cmd.name === 'tools');

    if (!tools) throw new Error('Expected /tools to be registered');

    expect(openRegisteredCliSlashForm(tools, '')).toBe(true);
    expect(activeForm.get()?.commandName).toBe('tools');
  });

  it('opens structured forms by registered command name or alias', () => {
    registerBuiltinSlashCommands();

    expect(openCliSlashCommandForm('TOOLS', '')).toBe(true);
    expect(activeForm.get()?.commandName).toBe('tools');

    expect(openCliSlashCommandForm('skill', '')).toBe(true);
    expect(activeForm.get()?.commandName).toBe('skills');
  });

  it('chains selectable agent picks into the API-mode-aware model picker', async () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    registerBuiltinSlashCommands();
    const agent = listSlashCommands().find((cmd) => cmd.name === 'agent');

    if (!agent) throw new Error('Expected /agent to be registered');

    expect(openRegisteredCliSlashForm(agent, '')).toBe(true);

    const agentNode = renderFormAdapter<{
      onSelect?: (value: string) => void;
    }>(activeForm.get()?.render(() => {}, 20));
    agentNode.props?.onSelect?.('review');
    await settleFormSelection();

    expect(sessionMeta.get().agent).toBe('review');
    expect(activeForm.get()?.commandName).toBe('model');

    const modelNode = renderFormAdapter<{
      apiMode?: string;
      selectable?: boolean;
    }>(activeForm.get()?.render(() => {}, 20));
    expect(modelNode.props).toMatchObject({
      apiMode: 'included',
      selectable: true,
    });
  });

  it('does not advance agent picks into the model form when model selection is unavailable', async () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    registerBuiltinSlashCommands({
      canSelectModel: () => false,
    });
    const agent = listSlashCommands().find((cmd) => cmd.name === 'agent');

    if (!agent) throw new Error('Expected /agent to be registered');

    expect(openRegisteredCliSlashForm(agent, '')).toBe(true);

    const agentNode = renderOpenForm<{
      onSelect?: (value: string) => void;
    }>();
    agentNode.props?.onSelect?.('review');
    await settleFormSelection();

    expect(sessionMeta.get().agent).toBe('review');
    expect(agentNode.isClosed()).toBe(true);
    expect(activeForm.get()?.commandName).toBe('agent');
  });

  it('marks the agent picker read-only when root selection is closed', () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    registerBuiltinSlashCommands({
      canSelectAgent: () => false,
      canSelectModel: () => true,
    });
    const agent = listSlashCommands().find((cmd) => cmd.name === 'agent');

    if (!agent) throw new Error('Expected /agent to be registered');

    expect(openRegisteredCliSlashForm(agent, '')).toBe(true);

    const agentNode = renderFormAdapter<{
      selectable?: boolean;
    }>(activeForm.get()?.render(() => {}, 20));

    expect(agentNode.props).toMatchObject({ selectable: false });
    expect(activeForm.get()?.commandName).toBe('agent');
  });

  it('keeps the model picker selectable after root agent selection is closed', () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    registerBuiltinSlashCommands({
      canSelectAgent: () => false,
      canSelectModel: () => true,
    });
    const model = listSlashCommands().find((cmd) => cmd.name === 'model');

    if (!model) throw new Error('Expected /model to be registered');

    expect(openRegisteredCliSlashForm(model, '')).toBe(true);

    const modelNode = renderFormAdapter<{
      onSelect?: (value: string) => void;
      selectable?: boolean;
    }>(activeForm.get()?.render(() => {}, 20));
    modelNode.props?.onSelect?.('gpt55');

    expect(modelNode.props).toMatchObject({ selectable: true });
    expect(sessionMeta.get()).toMatchObject({
      model: 'gpt55',
      modelSource: 'explicit-override',
    });
  });

  it('passes live model-switch disabled reasons into the model picker', () => {
    resetCliState({
      agent: 'chat',
      category: AgentCategory.ToolUse,
      model: 'gpt54',
      modelSource: 'explicit-override',
      cwd: '/tmp/workspace',
      apiMode: 'personal',
      approvalPolicy: 'ask',
      canDelegate: false,
      transcriptMode: 'persistent',
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
    }>(activeForm.get()?.render(() => {}, 20));

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

  it('defers a form command echo until a persistent selection', async () => {
    const events: string[] = [];
    registerBuiltinSlashCommands({
      onModelSelect: () => {
        events.push('outcome');
      },
    });
    const model = listSlashCommands().find((cmd) => cmd.name === 'model');
    if (!model) throw new Error('Expected /model to be registered');

    openRegisteredCliSlashForm(model, '', () => events.push('echo'));
    expect(events).toEqual([]);

    const modelNode = renderOpenForm<{
      onSelect?: (value: string) => void;
    }>();
    modelNode.props?.onSelect?.('gpt55');
    await settleFormSelection();

    expect(events).toEqual(['echo', 'outcome']);
  });

  it('routes model picker selection failures to the shared error handler', async () => {
    const errors: string[] = [];
    registerBuiltinSlashCommands({
      onModelSelect: async () => {
        throw new Error('model failed');
      },
      onError: (error) => {
        errors.push(toErrorMessage(error));
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
    resetCliState(INCLUDED_CHAT_SESSION);
    const errors: string[] = [];
    registerBuiltinSlashCommands({
      onModelAccessSelect: async () => {
        throw new Error('api mode failed');
      },
      onError: (error) => {
        errors.push(toErrorMessage(error));
      },
    });
    const api = listSlashCommands().find((cmd) => cmd.name === 'api');

    if (!api) throw new Error('Expected /api to be registered');

    expect(openRegisteredCliSlashForm(api, '')).toBe(true);

    const apiNode = renderOpenForm<{
      onSelect?: (value: CliModelAccessRoute) => void;
    }>();
    apiNode.props?.onSelect?.('personal');
    await settleFormSelection();

    expect(errors).toEqual(['api mode failed']);
    expect(apiNode.isClosed()).toBe(true);
  });

  it('closes the model-access picker before an asynchronous action', async () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    const selection = deferredSelection();
    registerBuiltinSlashCommands({
      onModelAccessSelect: () => selection.promise,
    });
    const api = listSlashCommands().find((cmd) => cmd.name === 'api');

    if (!api) throw new Error('Expected /api to be registered');

    expect(openRegisteredCliSlashForm(api, '')).toBe(true);

    const apiNode = renderOpenForm<{
      onSelect?: (value: CliModelAccessRoute) => void;
    }>();
    apiNode.props?.onSelect?.('personal');
    await settleFormSelection();

    expect(apiNode.isClosed()).toBe(true);

    selection.resolve();
    await settleFormSelection();

    expect(apiNode.isClosed()).toBe(true);
  });

  it('keeps provider API keys inside the masked local form', async () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    const saves: Array<{ provider: string; key: string }> = [];
    registerBuiltinSlashCommands({
      onApiKeySave: async (provider, key) => {
        saves.push({ provider, key });
      },
    });
    const keyCommand = findSlashCommand('keys');

    if (!keyCommand) throw new Error('Expected /key to be registered');
    expect(keyCommand.formEscapeAction).toBe('close');

    expect(openRegisteredCliSlashForm(keyCommand, '')).toBe(true);
    const keyNode = renderOpenForm<{
      onSave?: (provider: 'moonshot', key: string) => Promise<void>;
      onCancel?: () => void;
    }>();

    await keyNode.props?.onSave?.('moonshot', 'private-test-value');
    expect(saves).toEqual([
      { provider: 'moonshot', key: 'private-test-value' },
    ]);
    expect(keyNode.isClosed()).toBe(false);

    keyNode.props?.onCancel?.();
    expect(keyNode.isClosed()).toBe(true);
  });

  it('closes the login picker before running the selected login path', async () => {
    const selected: string[] = [];
    let closed = false;
    let sawClosedBeforeLogin = false;
    registerBuiltinSlashCommands({
      onLoginSelect: (value) => {
        sawClosedBeforeLogin = closed;
        selected.push(value);
      },
    });
    const login = listSlashCommands().find((cmd) => cmd.name === 'login');

    if (!login) throw new Error('Expected /login to be registered');

    expect(openRegisteredCliSlashForm(login, '')).toBe(true);

    const loginNode = renderFormAdapter<{
      onSelect?: (value: string) => void;
    }>(
      activeForm.get()?.render(() => {
        closed = true;
      }, 20),
    );
    loginNode.props?.onSelect?.('chatgpt');
    await settleFormSelection();

    expect(selected).toEqual(['chatgpt']);
    expect(closed).toBe(true);
    expect(sawClosedBeforeLogin).toBe(true);
  });

  it('closes the approval policy picker before applying the new policy', async () => {
    let closed = false;
    let sawClosedBeforePolicySelect = false;
    registerBuiltinSlashCommands({
      onApprovalPolicySelect: () => {
        sawClosedBeforePolicySelect = closed;
      },
    });
    const approval = listSlashCommands().find((cmd) => cmd.name === 'approval');

    if (!approval) throw new Error('Expected /approval to be registered');

    expect(openRegisteredCliSlashForm(approval, '')).toBe(true);

    const approvalNode = renderFormAdapter<{
      onSelect?: (value: CliApprovalPolicy) => void;
    }>(
      activeForm.get()?.render(() => {
        closed = true;
      }, 20),
    );
    approvalNode.props?.onSelect?.('yolo');
    await settleFormSelection();

    expect(closed).toBe(true);
    expect(sawClosedBeforePolicySelect).toBe(true);
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
      activeForm.get()?.render(() => {
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
      activeForm.get()?.render(() => {
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

  it('falls back to substring matches when no prefix matches', () => {
    registerSlashCommand({ name: 'model', description: 'pick a model' });
    registerSlashCommand({ name: 'agent', description: 'pick an agent' });

    expect(matchSlashCommands('odel').map((c) => c.name)).toEqual(['model']);
    expect(matchSlashCommands('gen').map((c) => c.name)).toEqual(['agent']);
    // Prefix matches still win outright when present.
    expect(matchSlashCommands('mo').map((c) => c.name)).toEqual(['model']);
  });

  it('falls back to the typo suggestion when nothing matches literally', () => {
    registerSlashCommand({ name: 'help', description: 'show help' });
    registerSlashCommand({ name: 'model', description: 'pick a model' });

    expect(matchSlashCommands('hlp').map((c) => c.name)).toEqual(['help']);
    expect(matchSlashCommands('frobnicate')).toEqual([]);
  });

  it('keeps the auto-run tier prefix-only so fallbacks never fire blind', () => {
    registerSlashCommand({ name: 'help', description: 'show help' });
    registerSlashCommand({ name: 'model', description: 'pick a model' });

    expect(prefixSlashCommands('mo').map((c) => c.name)).toEqual(['model']);
    // Substring ('odel') and typo ('hlp') matches are palette-only.
    expect(prefixSlashCommands('odel')).toEqual([]);
    expect(prefixSlashCommands('hlp')).toEqual([]);
  });

  it('finds exact command names and aliases case-insensitively', () => {
    registerSlashCommand({
      name: 'agent',
      description: 'pick an agent',
      aliases: ['agents'],
    });

    expect(findSlashCommand('agent')?.name).toBe('agent');
    expect(findSlashCommand('AGENTS')?.name).toBe('agent');
    expect(findSlashCommand('age')).toBeUndefined();
  });

  it('submits no-form commands on Enter and completes on Tab', () => {
    const help = { name: 'help', description: 'show help', aliases: ['h'] };
    registerSlashCommand(help);

    expect(slashPickIntent(help, 'enter')).toBe('submit');
    expect(slashPickIntent(help, 'tab')).toBe('complete');
  });

  it('suggests the closest command for a typo within the shared threshold', () => {
    registerBuiltinSlashCommands();

    expect(suggestSlashCommand('modl')?.name).toBe('model');
    expect(suggestSlashCommand('aprooval')?.name).toBe('approval');
    expect(suggestSlashCommand('sttus')?.name).toBe('status');
  });

  it('matches typo suggestions against aliases too', () => {
    registerSlashCommand({
      name: 'exit',
      description: 'Exit the CLI session',
      aliases: ['quit'],
    });

    expect(suggestSlashCommand('quitt')?.name).toBe('exit');
  });

  it('returns no suggestion for input far from every command', () => {
    registerBuiltinSlashCommands();

    expect(suggestSlashCommand('frobnicate')).toBeUndefined();
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
    expect(parseSlashInput('\\goal')).toEqual({
      name: 'goal',
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

  it('treats non-command-shaped leading tokens as chat messages', () => {
    // Pasted absolute paths.
    expect(parseSlashInput('/Users/me/poster/mpq_logo.pdf')).toBeUndefined();
    expect(
      parseSlashInput('/Users/me/poster/mpq_logo.pdf just use this then'),
    ).toBeUndefined();
    expect(parseSlashInput('/tmp/figure.png looks wrong')).toBeUndefined();
    // Single-segment tokens with characters no command name contains.
    expect(parseSlashInput('/mpq_logo.pdf')).toBeUndefined();
    expect(parseSlashInput('/3.14 is pi')).toBeUndefined();
    expect(parseSlashInput('/(a+b)')).toBeUndefined();
  });

  it('still parses command-shaped near-misses so typo suggestions fire', () => {
    expect(parseSlashInput('/hlp')).toEqual({ name: 'hlp', remainder: '' });
    expect(parseSlashInput('/my-cmd_2 arg')).toEqual({
      name: 'my-cmd_2',
      remainder: 'arg',
    });
    // Bare `/` keeps parsing so the palette opens on an empty query.
    expect(parseSlashInput('/')).toEqual({ name: '', remainder: '' });
  });
});
