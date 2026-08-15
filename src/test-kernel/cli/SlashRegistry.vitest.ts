// Slash command registry and parse helpers.

// Test composition imports
import '@test/support/defaultSessionTestSetup';

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
  type SlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import {
  openCliSlashCommandForm,
  openRegisteredCliSlashForm,
} from '@cli/chat/tui/commands/slashForms';
import { LOGIN_FORM_ITEMS } from '@cli/chat/tui/forms/LoginForm';
import {
  activeForm,
  formProgress,
  resetCliState,
  sessionMeta,
  streams,
  transientNotice,
  type SessionMeta,
} from '@cli/chat/tui/state/cliState';
import { CLI_LOCAL_STREAM_ID } from '@cli/chat/tui/state/transcript';
import {
  cliApiFallbackSelection,
  type CliModelAccessSelection,
} from '@cli/runtime/modelAccessRoute';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { AgentCategory } from '@shared/schemas';
import { loadInk, renderInteractive } from '@test/support/inkTestHarness.ts';
import {
  createDeferred,
  waitForCondition as waitFor,
} from '@test/support/asyncTestUtils';
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

const PERSONAL_CHAT_SESSION: SessionMeta = {
  ...INCLUDED_CHAT_SESSION,
  model: 'gpt54',
  modelSource: 'explicit-override',
  apiMode: 'personal',
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

  function requireSlashCommand(name: string): SlashCommand {
    const command = findSlashCommand(name);
    if (!command) throw new Error(`Expected /${name} to be registered`);
    return command;
  }

  /** Open a registered slash command's form and render its adapter node. */
  function openSlashForm<TProps>(name: string): {
    readonly props?: TProps;
    readonly isClosed: () => boolean;
  } {
    expect(openRegisteredCliSlashForm(requireSlashCommand(name), '')).toBe(
      true,
    );
    return renderOpenForm<TProps>();
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

  /** Both form openers must hold the command echo until selection settles. */
  async function expectDeferredEcho(
    openForm: (onEcho: () => void) => unknown,
  ): Promise<void> {
    const events: string[] = [];
    registerBuiltinSlashCommands({
      onModelSelect: () => {
        events.push('outcome');
      },
    });
    openForm(() => events.push('echo'));
    expect(events).toEqual([]);

    const modelNode = renderOpenForm<{
      onSelect?: (value: string) => void;
    }>();
    modelNode.props?.onSelect?.('gpt55');
    await settleFormSelection();

    expect(events).toEqual(['echo', 'outcome']);
  }

  it('keeps the CLI session control commands registered', () => {
    registerBuiltinSlashCommands();
    expect(listSlashCommands().map((cmd) => cmd.name)).toEqual(
      expect.arrayContaining([
        'agent',
        'model',
        'models',
        'api',
        'key',
        'auth',
        'login',
        'logout',
        'approval',
        'yolo',
        'status',
        'plan',
        'goal',
        'resume',
        'memory',
        'skills',
        'tools',
        'compact',
      ]),
    );
    const withForm = {
      formComponent: expect.any(Function),
    };
    const expectedShapes: ReadonlyArray<readonly [string, object]> = [
      ['model', { description: 'Choose the model for this chat' }],
      [
        'models',
        {
          description: 'Enable or disable models in pickers',
          ...withForm,
        },
      ],
      ['agent', { description: 'List or choose the root agent', ...withForm }],
      ['approval', { description: 'Switch approval policy', ...withForm }],
      ['memory', { description: 'List stored memories', ...withForm }],
      ['resume', { description: 'Resume a previous session', ...withForm }],
      [
        'tools',
        { description: 'List or toggle external integrations', ...withForm },
      ],
      [
        'skills',
        {
          description: 'List skills or activate one',
          aliases: ['skill'],
          ...withForm,
        },
      ],
      [
        'login',
        {
          description: 'Sign in to ChatGPT or Researcher Access',
          ...withForm,
        },
      ],
      ['plan', { description: 'Read the focused session work plan' }],
      ['compact', { description: 'Request context compaction' }],
    ];
    for (const [name, shape] of expectedShapes) {
      expect(requireSlashCommand(name)).toEqual(expect.objectContaining(shape));
    }
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
    const tools = requireSlashCommand('tools');
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
    const agentNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('agent');
    agentNode.props?.onSelect?.('review');
    await settleFormSelection();

    expect(sessionMeta.get().agent).toBe('review');
    expect(activeForm.get()?.commandName).toBe('model');

    const modelNode = renderOpenForm<{
      apiMode?: string;
      selectable?: boolean;
    }>();
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
    const agentNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('agent');
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
    const agentNode = openSlashForm<{
      selectable?: boolean;
    }>('agent');

    expect(agentNode.props).toMatchObject({ selectable: false });
    expect(activeForm.get()?.commandName).toBe('agent');
  });

  it('keeps the model picker selectable after root agent selection is closed', () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    registerBuiltinSlashCommands({
      canSelectAgent: () => false,
      canSelectModel: () => true,
    });
    const modelNode = openSlashForm<{
      onSelect?: (value: string) => void;
      selectable?: boolean;
    }>('model');
    modelNode.props?.onSelect?.('gpt55');

    expect(modelNode.props).toMatchObject({ selectable: true });
    expect(sessionMeta.get()).toMatchObject({
      model: 'gpt55',
      modelSource: 'explicit-override',
    });
  });

  it('passes live model-switch disabled reasons into the model picker', () => {
    resetCliState(PERSONAL_CHAT_SESSION);
    registerBuiltinSlashCommands({
      canSelectModel: () => true,
      getModelSwitchDisabledReason: (model) =>
        model === 'sonnet46T'
          ? 'different conversation format; start new chat'
          : undefined,
    });
    const modelNode = openSlashForm<{
      getModelSwitchDisabledReason?: (model: string) => string | undefined;
    }>('model');

    expect(modelNode.props?.getModelSwitchDisabledReason?.('sonnet46T')).toBe(
      'different conversation format; start new chat',
    );
    expect(modelNode.props?.getModelSwitchDisabledReason?.('gpt55')).toBe(
      undefined,
    );
  });

  it('keeps the model picker open until model selection commits', async () => {
    const selection = createDeferred<void>();
    registerBuiltinSlashCommands({
      onModelSelect: () => selection.promise,
    });
    const modelNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('model');
    modelNode.props?.onSelect?.('gpt55');
    await settleFormSelection();

    expect(modelNode.isClosed()).toBe(false);

    selection.resolve();
    await settleFormSelection();

    expect(modelNode.isClosed()).toBe(true);
  });

  it('defers a form command echo until a persistent selection', async () => {
    await expectDeferredEcho((onEcho) => {
      openRegisteredCliSlashForm(requireSlashCommand('model'), '', onEcho);
    });
  });

  it('preserves deferred echo through the command-name form helper', async () => {
    await expectDeferredEcho((onEcho) => {
      openCliSlashCommandForm('model', '', onEcho);
    });
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
    const modelNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('model');
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
    const apiNode = openSlashForm<{
      onSelect?: (value: CliModelAccessSelection) => void;
    }>('api');
    apiNode.props?.onSelect?.(cliApiFallbackSelection('personal'));
    await settleFormSelection();

    expect(errors).toEqual(['api mode failed']);
    // Selecting "Your own API keys" still advances to the key configuration
    // form so the user can set keys even when the mode switch itself failed.
    expect(activeForm.get()?.commandName).toBe('key');
  });

  it('keeps model-access selection in a busy form until it settles', async () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    const selection = createDeferred<void>();
    registerBuiltinSlashCommands({
      onModelAccessSelect: () => selection.promise,
    });
    const apiNode = openSlashForm<{
      onSelect?: (value: CliModelAccessSelection) => void;
    }>('api');
    apiNode.props?.onSelect?.(cliApiFallbackSelection('personal'));
    await settleFormSelection();

    expect(apiNode.isClosed()).toBe(false);
    expect(formProgress.get()).toMatchObject({
      status: 'running',
      title: 'Updating model access',
    });

    selection.resolve();
    await settleFormSelection();

    // After switching to personal mode, the API key configuration form opens
    // in place of the model access form.
    expect(activeForm.get()?.commandName).toBe('key');
  });

  it('keeps provider API keys inside the masked local form', async () => {
    resetCliState(INCLUDED_CHAT_SESSION);
    const saves: Array<{ provider: string; key: string }> = [];
    registerBuiltinSlashCommands({
      onApiKeySave: async (provider, key) => {
        saves.push({ provider, key });
      },
    });
    const keyCommand = requireSlashCommand('keys');
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

  it('closes the login form after the selected login path settles', async () => {
    const selected: string[] = [];
    let sawClosedBeforeLogin = false;
    registerBuiltinSlashCommands({
      onLoginSelect: (value) => {
        sawClosedBeforeLogin = loginNode.isClosed();
        selected.push(value);
      },
    });
    const loginNode = openSlashForm<{ onSelect?: (value: string) => void }>(
      'login',
    );
    loginNode.props?.onSelect?.('chatgpt');
    await settleFormSelection();

    expect(selected).toEqual(['chatgpt']);
    expect(loginNode.isClosed()).toBe(true);
    expect(sawClosedBeforeLogin).toBe(false);
  });

  it('holds a copyable login frame until the user dismisses it', async () => {
    registerBuiltinSlashCommands({
      onLoginSelect: (_value, output) => {
        output.writeProgress('Open https://example.test/device', {
          copyable: true,
        });
      },
    });

    const loginNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('login');
    loginNode.props?.onSelect?.('chatgpt');
    await settleFormSelection();

    expect(loginNode.isClosed()).toBe(false);
    expect(formProgress.get()).toMatchObject({
      status: 'succeeded',
      message: 'Open https://example.test/device',
      copyableMessage: 'Open https://example.test/device',
    });

    formProgress.get()?.dismiss();
    expect(loginNode.isClosed()).toBe(true);
  });

  it('moves a login instruction to scrollback when its frame cannot fit', async () => {
    const instruction =
      'Open https://example.test/device and enter verification code ABCD-EFGH';
    registerBuiltinSlashCommands({
      onLoginSelect: (_value, output) => {
        output.writeProgress(instruction, { copyable: true });
      },
    });

    const loginNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('login');
    loginNode.props?.onSelect?.('chatgpt');
    await waitFor(() => formProgress.get()?.status === 'succeeded');
    expect(formProgress.get()?.archiveCopyable).toBeTypeOf('function');

    const { ink } = await loadInk();
    const { instance, stdout } = renderInteractive(
      ink,
      activeForm.get()?.render(() => {}, 20),
    );
    try {
      instance.rerender(activeForm.get()?.render(() => {}, 4));
      await waitFor(
        () => formProgress.get()?.archivedCopyableMessage === instruction,
      );
      await waitFor(() => stdout.output.includes('scrollback'));
      expect(stdout.output).toContain('scrollback');
      expect(formProgress.get()).toMatchObject({
        status: 'succeeded',
        message: 'Authentication instructions were written to scrollback.',
        copyableMessage: undefined,
        archivedCopyableMessage: instruction,
      });
      expect(
        streams
          .get()
          .get(CLI_LOCAL_STREAM_ID)
          ?.entries.map((entry) => entry.text),
      ).toEqual([instruction]);
    } finally {
      instance.unmount();
    }
  });

  it('detaches a busy login and ignores its late completion', async () => {
    const selection = createDeferred<void>();
    registerBuiltinSlashCommands({
      onLoginSelect: (_value, output) => {
        output.writeProgress('Open https://example.test/device', {
          copyable: true,
        });
        return selection.promise;
      },
    });

    const loginNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('login');
    loginNode.props?.onSelect?.('chatgpt');
    formProgress.get()?.cancel();

    expect(loginNode.isClosed()).toBe(true);
    expect(formProgress.get()).toBeUndefined();
    expect(transientNotice.get()?.text).toContain('Sign-in abandoned');

    selection.resolve();
    await settleFormSelection();
    expect(formProgress.get()).toBeUndefined();
  });

  it('keeps a failed login URL in its one persistent error', async () => {
    const errors: string[] = [];
    registerBuiltinSlashCommands({
      onLoginSelect: (_value, output) => {
        output.writeProgress('Open https://example.test/manual', {
          copyable: true,
        });
        throw new Error('Sign-in failed');
      },
      onError: (error) => {
        errors.push(toErrorMessage(error));
      },
    });

    const loginNode = openSlashForm<{
      onSelect?: (value: string) => void;
    }>('login');
    loginNode.props?.onSelect?.('chatgpt');
    await settleFormSelection();

    expect(errors).toEqual([
      'Sign-in failed · Open https://example.test/manual',
    ]);
    expect(formProgress.get()).toMatchObject({
      status: 'failed',
      copyableMessage: 'Open https://example.test/manual',
    });
    expect(loginNode.isClosed()).toBe(false);
  });

  it('drops a busy form completion after CLI state reset', async () => {
    const selection = createDeferred<void>();
    const outcomes: string[] = [];
    registerBuiltinSlashCommands({
      onModelAccessSelect: async (_value, output) => {
        await selection.promise;
        output.appendOutcome('late outcome');
        outcomes.push('action settled');
      },
    });

    const apiNode = openSlashForm<{
      onSelect?: (value: CliModelAccessSelection) => void;
    }>('api');
    apiNode.props?.onSelect?.(cliApiFallbackSelection('personal'));
    resetCliState(INCLUDED_CHAT_SESSION);
    selection.resolve();
    await settleFormSelection();

    expect(outcomes).toEqual(['action settled']);
    expect(formProgress.get()).toBeUndefined();
    expect(apiNode.isClosed()).toBe(false);
  });

  it('calls an available abort hook when a busy form is cancelled', () => {
    let aborted = false;
    const selection = createDeferred<void>();
    const completion = selection.promise as Promise<void> & {
      abort?: () => void;
    };
    completion.abort = () => {
      aborted = true;
    };
    registerBuiltinSlashCommands({
      onLogoutSelect: () => completion,
    });

    const logoutNode = openSlashForm<{
      onSelect?: (value: 'all') => void;
    }>('logout');
    logoutNode.props?.onSelect?.('all');
    formProgress.get()?.cancel();

    expect(aborted).toBe(true);
    expect(transientNotice.get()).toBeUndefined();
  });

  it('closes the approval policy picker before applying the new policy', async () => {
    let sawClosedBeforePolicySelect = false;
    registerBuiltinSlashCommands({
      onApprovalPolicySelect: () => {
        sawClosedBeforePolicySelect = approvalNode.isClosed();
      },
    });
    const approvalNode = openSlashForm<{
      onSelect?: (value: TexraApprovalPolicy) => void;
    }>('approval');
    approvalNode.props?.onSelect?.('yolo');
    await settleFormSelection();

    expect(approvalNode.isClosed()).toBe(true);
    expect(sawClosedBeforePolicySelect).toBe(true);
  });

  it('closes the resume picker before running the resume action', async () => {
    let sawClosedBeforeResume = false;
    registerBuiltinSlashCommands({
      onResumeSelect: async () => {
        sawClosedBeforeResume = resumeNode.isClosed();
      },
    });
    const resumeNode = openSlashForm<{ onSelect?: (id: string) => void }>(
      'resume',
    );
    resumeNode.props?.onSelect?.('previous-session');
    await settleFormSelection();

    expect(resumeNode.isClosed()).toBe(true);
    expect(sawClosedBeforeResume).toBe(true);
  });

  it('routes skill picker selections through the shared handler', async () => {
    const selected: string[] = [];
    let sawClosedBeforeSkillSelect = false;
    registerBuiltinSlashCommands({
      onSkillSelect: (value) => {
        sawClosedBeforeSkillSelect = skillsNode.isClosed();
        selected.push(value.activationPrompt);
      },
    });
    const skillsNode = openSlashForm<{
      onSelect?: (value: {
        readonly name: string;
        readonly activationPrompt: string;
      }) => void;
    }>('skills');
    skillsNode.props?.onSelect?.({
      name: 'proof-audit',
      activationPrompt: '<skill_activation>proof-audit</skill_activation>',
    });
    await settleFormSelection();

    expect(selected).toEqual([
      '<skill_activation>proof-audit</skill_activation>',
    ]);
    expect(skillsNode.isClosed()).toBe(true);
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
