import { setTimeout as sleep } from 'node:timers/promises';

import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  buildConfigListItems,
  buildEnumItems,
  coerceSettingInput,
  formatSettingValue,
  isConfigResetInput,
  settingDisplayName,
  settingEditKind,
  settingStoreLabel,
  validateSettingInput,
} from '@cli/chat/tui/forms/ConfigForm';
import {
  buildConfigCategoryItems,
  configCategoryLabel,
} from '@cli/chat/tui/forms/configCategories';
import {
  CliConfigForm,
  createCliConfigFormProps,
} from '@cli/chat/tui/forms/CliConfigForm';
import {
  buildProviderApiKeyItems,
  formatProviderApiKeySummary,
} from '@cli/chat/tui/forms/ProviderApiKeyForm';
import {
  listSlashCommands,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { openCliSlashCommandForm } from '@cli/chat/tui/commands/slashForms';
import { ConfigApp } from '@cli/config/runConfigTui';
import type { CliModelAccessSelection } from '@cli/runtime/modelAccessRoute';
import {
  activeForm,
  resetCliState,
  sessionMeta,
} from '@cli/chat/tui/state/cliState';
import {
  API_PROVIDERS,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { AgentCategory } from '@shared/schemas/agent';
import {
  CLI_STATE_SETTINGS,
  DEFAULT_GIT_AUTHOR_NAME,
  SETTINGS_VIEW_CORE_SETTINGS,
  STATE_SETTINGS,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import {
  loadInk,
  renderInteractive,
  type FakeStdin,
  type FakeStdout,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';
import { getGitAuthorEnv } from '@utils/system/gitAuthorEnv';

const invalidateModelOptionsCache = vi.hoisted(() => vi.fn());
const providerApiKeyRuntime = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache,
}));
vi.mock('@cli/runtime/providerApiKey', () => ({
  loadProviderApiKeyStatuses: providerApiKeyRuntime.load,
  saveProviderApiKey: providerApiKeyRuntime.save,
}));

function apiKeyStatuses(
  overrides: Partial<Record<ApiProvider, ApiKeyStatus>> = {},
): Record<ApiProvider, ApiKeyStatus> {
  return Object.fromEntries(
    API_PROVIDERS.map((provider) => [
      provider,
      overrides[provider] ?? 'not-set',
    ]),
  ) as Record<ApiProvider, ApiKeyStatus>;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  invalidateModelOptionsCache.mockClear();
  providerApiKeyRuntime.load.mockReset();
  providerApiKeyRuntime.load.mockResolvedValue(apiKeyStatuses());
  providerApiKeyRuntime.save.mockReset();
  providerApiKeyRuntime.save.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  resetCliState();
});

function entryByKey(key: string): StateSettingEntry {
  const entry = STATE_SETTINGS.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`missing catalog entry ${key}`);
  return entry;
}

async function renderInkElement(element: unknown): Promise<InkRenderHandles> {
  const { ink } = await loadInk();
  const handles = renderInteractive(ink, element, { columns: 100, rows: 30 });
  await waitFor(() => handles.stdin.listenerCount('readable') > 0);
  return handles;
}

async function renderCliConfigForm(
  onError?: (error: unknown) => void,
): Promise<Awaited<ReturnType<typeof renderInkElement>>> {
  const { React } = await loadInk();
  return renderInkElement(
    React.createElement(CliConfigForm, {
      stores: makeFakeSettingsStores().stores,
      onClose: () => undefined,
      onError,
    }),
  );
}

async function submitOpenAiApiKey(
  stdin: FakeStdin,
  stdout: FakeStdout,
  key = 'sk-private-test-key',
): Promise<void> {
  stdin.write('2');
  await waitFor(() => stdout.output.includes('Add provider API key'));
  stdin.write('1');
  await waitFor(() => stdout.output.includes('Use my own provider API key'));
  stdin.write(key);
  stdin.write('\r');
}

interface RenderedConfigFormProps {
  entries?: readonly StateSettingEntry[];
  readValue?: (entry: StateSettingEntry) => unknown;
  writeValue?: (
    entry: StateSettingEntry,
    value: unknown,
  ) => void | Promise<void>;
  resetValue?: (entry: StateSettingEntry) => void | Promise<void>;
  openForm?: (formName: string) => void;
  onError?: (error: unknown) => void;
  formRenderers?: Readonly<
    Record<string, (onBack: () => void) => React.JSX.Element>
  >;
  formLinks?: readonly {
    readonly name: string;
    readonly label: string;
    readonly description: string;
  }[];
  availableRows?: number;
}

function renderConfigFormProps(): RenderedConfigFormProps {
  const node = activeForm.get()?.render(() => {}, 20) as {
    type?: (props: unknown) => unknown;
    props?: unknown;
  };
  if (typeof node?.type !== 'function') {
    throw new TypeError('Expected /config form adapter element');
  }
  const rendered = node.type(node.props) as {
    type?: unknown;
    props?: ReturnType<typeof Object>;
  };
  if (rendered.type === CliConfigForm) {
    const props = rendered.props as Parameters<typeof CliConfigForm>[0];
    if (!props.stores) throw new TypeError('Expected /config stores');
    // The spread narrows `stores` from optional to required for the input type.
    return createCliConfigFormProps({ ...props, stores: props.stores });
  }
  return (rendered.props ?? {}) as RenderedConfigFormProps;
}

function openConfigFormProps(
  stores = makeFakeSettingsStores().stores,
): RenderedConfigFormProps {
  registerBuiltinSlashCommands({ getConfigStores: () => stores });
  openCliSlashCommandForm('config', '');
  return renderConfigFormProps();
}

describe('ConfigForm helpers', () => {
  it('rosters exactly the CLI-consumed catalog entries', () => {
    expect([...CLI_STATE_SETTINGS].map((entry) => entry.key)).toEqual(
      [...STATE_SETTINGS, ...SETTINGS_VIEW_CORE_SETTINGS]
        .filter((entry) => entry.hosts.includes('cli'))
        .map((entry) => entry.key),
    );
    expect(CLI_STATE_SETTINGS.length).toBeGreaterThan(0);
    // Every rostered entry must be reachable from the CLI's store set.
    for (const entry of CLI_STATE_SETTINGS) {
      expect(entry.hosts).toContain('cli');
    }
  });

  it.each<[string, string]>([
    [WorkspaceStateKey.GIT_MARK_COMMITS, 'boolean'],
    [WorkspaceStateKey.GIT_AUTHOR_NAME, 'string'],
    [WorkspaceStateKey.LATEX_FORMATTER, 'enum'],
    [GlobalStateKey.DISABLED_TOOLS, 'form'],
    [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS, 'number'],
  ])('classifies %s as a %s edit kind', (key, kind) => {
    expect(settingEditKind(entryByKey(key))).toBe(kind);
  });

  it.each<[string, boolean, ReturnType<typeof coerceSettingInput>]>([
    ['texra-ai', false, { ok: true, value: 'texra-ai' }],
    ['', false, { ok: true, value: '' }],
    ['120000', true, { ok: true, value: 120000 }],
    ['  90000 ', true, { ok: true, value: 90000 }],
    [
      '',
      true,
      { ok: false, message: 'Enter a number, or press Ctrl-R to reset.' },
    ],
    ['abc', true, { ok: false, message: 'Enter a finite number.' }],
    ['Infinity', true, { ok: false, message: 'Enter a finite number.' }],
  ])('coerces %j input (numeric=%s)', (input, numeric, expected) => {
    expect(coerceSettingInput(input, numeric)).toEqual(expected);
  });

  it('validates coerced text input against the setting schema', () => {
    const timeout = entryByKey(
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    );
    expect(validateSettingInput(timeout, '120000', true)).toEqual({
      ok: true,
      value: 120000,
    });

    const invalid = validateSettingInput(timeout, '0', true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).not.toBe('');
  });

  it.each<[string, Parameters<typeof isConfigResetInput>[1], boolean]>([
    ['r', { ctrl: true }, true],
    ['\u0012', {}, true],
    ['r', { meta: true }, false],
  ])(
    'recognizes parsed and raw Ctrl-R reset input (%j, %j)',
    (input, key, expected) => {
      expect(isConfigResetInput(input, key)).toBe(expected);
    },
  );

  it.each<[unknown, string]>([
    [true, 'on'],
    [false, 'off'],
    ['', '(empty)'],
    ['latexindent', 'latexindent'],
    [120000, '120000'],
  ])('formats %j for display as %j', (value, formatted) => {
    expect(formatSettingValue(value)).toBe(formatted);
  });

  it.each<[Parameters<typeof formatProviderApiKeySummary>[0], string]>([
    [
      {
        statuses: { openai: 'set', anthropic: 'not-set', kimiCode: 'env' },
        loading: false,
        error: false,
      },
      'Configured: OpenAI, Kimi Code',
    ],
    [
      { statuses: { openai: 'not-set' }, loading: false, error: false },
      'No provider keys set',
    ],
    [{ loading: false, error: true }, 'Status unavailable'],
  ])('summarizes key status without exposing values', (view, summary) => {
    expect(formatProviderApiKeySummary(view)).toBe(summary);
  });

  it('uses configured provider names in the parent API keys row', () => {
    const props = createCliConfigFormProps({
      stores: makeFakeSettingsStores().stores,
      apiKeyStatusView: {
        statuses: { openai: 'set', anthropic: 'not-set' },
        loading: false,
        error: false,
      },
      onClose: () => undefined,
    });
    expect(props.formLinks?.find((link) => link.name === 'api-keys')).toEqual({
      name: 'api-keys',
      label: 'API keys',
      description: 'Configured: OpenAI',
    });
  });

  it('labels configured and unconfigured provider key rows', () => {
    const items = buildProviderApiKeyItems({
      statuses: {
        openai: 'set',
        anthropic: 'not-set',
        kimiCode: 'env',
      },
      loading: false,
      error: false,
    });
    expect(items.find((item) => item.value === 'openai')).toMatchObject({
      label: 'OpenAI',
      description: 'Key set',
    });
    expect(items.find((item) => item.value === 'anthropic')).toMatchObject({
      label: 'Anthropic',
      description: 'Not set',
    });
    expect(items.find((item) => item.value === 'kimiCode')).toMatchObject({
      label: 'Kimi Code',
      description: 'Env',
    });
  });

  it.each<[string, string]>([
    [GlobalStateKey.DASHSCOPE_USE_CHINA, 'Qwen China region (Bailian)'],
    [GlobalStateKey.MINIMAX_USE_CHINA, 'MiniMax China region'],
    [GlobalStateKey.MOONSHOT_USE_CHINA, 'Kimi/Moonshot China region'],
    [GlobalStateKey.GLM_USE_CHINA, 'GLM China region'],
    [GlobalStateKey.GLM_CODING_PLAN, 'GLM Coding Plan'],
  ])('labels %s self-identifying as %j', (key, name) => {
    expect(settingDisplayName(entryByKey(key))).toBe(name);
  });

  it.each<[string, string]>([
    [WorkspaceStateKey.GIT_MARK_COMMITS, 'config'],
    [WorkspaceStateKey.LATEX_FORMATTER, 'workspaceState'],
  ])(
    'labels the store the CLI reads from for %s (cliStore wins)',
    (key, store) => {
      expect(settingStoreLabel(entryByKey(key))).toBe(store);
    },
  );

  it('prefers compact titles and falls back to stripped keys for display names', () => {
    expect(
      settingDisplayName(entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS)),
    ).toBe('Mark agent commits');

    expect(
      settingDisplayName({
        key: 'texra.example.record',
        schema: z.record(z.string(), z.string()).prefault({}),
        description: 'A record setting with no inline editor.',
        category: 'example',
        store: 'workspaceState',
        hosts: ['vscode'],
      }),
    ).toBe('example.record');
  });

  it('builds list items showing value + store, with editable rows enabled', () => {
    const items = buildConfigListItems(CLI_STATE_SETTINGS, (entry) =>
      entry.key === WorkspaceStateKey.GIT_MARK_COMMITS ? true : 'texra-ai',
    );
    const markCommits = items.find(
      (item) => item.value === WorkspaceStateKey.GIT_MARK_COMMITS,
    );
    const authorName = items.find(
      (item) => item.value === WorkspaceStateKey.GIT_AUTHOR_NAME,
    );
    const tools = items.find(
      (item) => item.value === GlobalStateKey.DISABLED_TOOLS,
    );

    expect(markCommits).toMatchObject({
      label: 'Mark agent commits',
      disabled: false,
    });
    expect(markCommits?.description).toContain('on');
    expect(markCommits?.description).toContain('config');
    // Strings/numbers are now editable, so no row is read-only in the roster.
    expect(authorName).toMatchObject({ disabled: false });
    expect(authorName?.description).not.toContain('read-only');
    expect(tools).toMatchObject({
      label: 'Tool integrations',
      description: 'open /tools · globalState',
      disabled: false,
    });
  });

  it('groups settings by catalog category with readable labels and counts', () => {
    const entries = [
      entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS),
      entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME),
      entryByKey(WorkspaceStateKey.CODEX_REASONING_EFFORT),
    ];

    expect(buildConfigCategoryItems(entries)).toEqual([
      {
        value: 'git',
        label: 'Git and worktrees',
        description: '2 settings',
      },
      {
        value: 'ai-agents',
        label: 'AI agents',
        description: '1 setting',
      },
    ]);
    expect(configCategoryLabel('custom-provider')).toBe('Custom Provider');
  });

  it('marks an unsupported schema kind read-only', () => {
    const recordEntry: StateSettingEntry = {
      key: 'texra.example.record',
      schema: z.record(z.string(), z.string()).prefault({}),
      description: 'A record setting with no inline editor.',
      category: 'example',
      store: 'workspaceState',
      hosts: ['vscode'],
    };
    expect(settingEditKind(recordEntry)).toBe('readonly');
    const [item] = buildConfigListItems([recordEntry], () => ({}));
    expect(item).toMatchObject({ disabled: true });
    expect(item?.description).toContain('read-only');
  });

  it('builds enum items from catalog enum metadata', () => {
    const formatter = entryByKey(WorkspaceStateKey.LATEX_FORMATTER);
    const items = buildEnumItems(formatter);
    expect(items.map((item) => item.value)).toEqual([
      'latexindent',
      'tex-fmt',
      'none',
    ]);
    expect(items[0]?.description).toBeTruthy();
  });
});

describe('CliConfigForm API-key status lifecycle', () => {
  it('renders initial loading and then configured status from the resolved request', async () => {
    const initial = deferred<Record<ApiProvider, ApiKeyStatus>>();
    providerApiKeyRuntime.load.mockReturnValueOnce(initial.promise);
    const rendered = await renderCliConfigForm();

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('Checking configured keys'),
      );
      rendered.stdout.output = '';
      initial.resolve(apiKeyStatuses({ openai: 'set' }));
      await waitFor(() =>
        rendered.stdout.output.includes('Configured: OpenAI'),
      );
    } finally {
      rendered.instance.unmount();
    }
  });

  it('settles a failed initial load to a stable unavailable state', async () => {
    const initial = deferred<Record<ApiProvider, ApiKeyStatus>>();
    const onError = vi.fn();
    providerApiKeyRuntime.load.mockReturnValueOnce(initial.promise);
    const rendered = await renderCliConfigForm(onError);

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('Checking configured keys'),
      );
      rendered.stdout.output = '';
      initial.reject(new Error('status backend unavailable'));
      await waitFor(() =>
        rendered.stdout.output.includes('Status unavailable'),
      );
      expect(rendered.stdout.output).not.toContain('Checking configured keys');
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      rendered.instance.unmount();
    }
  });

  it('refreshes provider status after saving without rendering the secret', async () => {
    const refreshed = deferred<Record<ApiProvider, ApiKeyStatus>>();
    providerApiKeyRuntime.load
      .mockResolvedValueOnce(apiKeyStatuses())
      .mockReturnValueOnce(refreshed.promise);
    const rendered = await renderCliConfigForm();

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('No provider keys set'),
      );
      rendered.stdout.output = '';
      await submitOpenAiApiKey(rendered.stdin, rendered.stdout);
      await waitFor(() => providerApiKeyRuntime.load.mock.calls.length === 2);
      expect(providerApiKeyRuntime.save).toHaveBeenCalledWith(
        'openai',
        'sk-private-test-key',
      );
      expect(rendered.stdout.output).not.toContain('sk-private-test-key');
      refreshed.resolve(apiKeyStatuses({ openai: 'set' }));
      await waitFor(() =>
        rendered.stdout.output.includes('Configured: OpenAI'),
      );
    } finally {
      rendered.instance.unmount();
    }
  });

  it('keeps a successfully saved key configured when its refresh fails', async () => {
    const refreshed = deferred<Record<ApiProvider, ApiKeyStatus>>();
    const onError = vi.fn();
    providerApiKeyRuntime.load
      .mockResolvedValueOnce(apiKeyStatuses({ openai: 'not-set' }))
      .mockReturnValueOnce(refreshed.promise);
    const rendered = await renderCliConfigForm(onError);

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('No provider keys set'),
      );
      rendered.stdout.output = '';
      await submitOpenAiApiKey(rendered.stdin, rendered.stdout);
      await waitFor(() => providerApiKeyRuntime.load.mock.calls.length === 2);
      rendered.stdout.output = '';
      refreshed.reject(new Error('refresh failed'));
      await waitFor(() =>
        rendered.stdout.output.includes(
          'Configured: OpenAI · status unavailable',
        ),
      );
      expect(rendered.stdout.output).not.toContain('refreshing');
      rendered.stdout.output = '';
      rendered.stdin.write('2');
      await waitFor(() =>
        rendered.stdout.output.includes('Add provider API key'),
      );
      expect(rendered.stdout.output).toContain('OpenAI — Key set');
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      rendered.instance.unmount();
    }
  });

  it('suppresses a stale mount response after the post-save refresh wins', async () => {
    const initial = deferred<Record<ApiProvider, ApiKeyStatus>>();
    const refreshed = deferred<Record<ApiProvider, ApiKeyStatus>>();
    providerApiKeyRuntime.load
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    const rendered = await renderCliConfigForm();

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('Checking configured keys'),
      );
      await submitOpenAiApiKey(rendered.stdin, rendered.stdout);
      await waitFor(() => providerApiKeyRuntime.load.mock.calls.length === 2);
      refreshed.resolve(apiKeyStatuses({ openai: 'set' }));
      await waitFor(() =>
        rendered.stdout.output.includes('Configured: OpenAI'),
      );
      rendered.stdout.output = '';
      initial.resolve(apiKeyStatuses());
      await sleep(20);
      expect(stripAnsi(rendered.stdout.output)).toBe('');
    } finally {
      rendered.instance.unmount();
    }
  });

  it('ignores a pending status response after unmount', async () => {
    const initial = deferred<Record<ApiProvider, ApiKeyStatus>>();
    const onError = vi.fn();
    providerApiKeyRuntime.load.mockReturnValueOnce(initial.promise);
    const rendered = await renderCliConfigForm(onError);

    await waitFor(() => providerApiKeyRuntime.load.mock.calls.length === 1);
    rendered.instance.unmount();
    rendered.stdout.output = '';
    initial.resolve(apiKeyStatuses({ openai: 'set' }));
    await sleep(20);
    expect(stripAnsi(rendered.stdout.output)).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });

  it('uses the same status-aware form in standalone config and /config', async () => {
    providerApiKeyRuntime.load.mockResolvedValue(
      apiKeyStatuses({
        openai: 'set',
      }),
    );
    const { React } = await loadInk();
    const standalone = await renderInkElement(
      React.createElement(ConfigApp, {}),
    );

    registerBuiltinSlashCommands({
      getConfigStores: () => makeFakeSettingsStores().stores,
    });
    openCliSlashCommandForm('config', '');
    const slash = await renderInkElement(
      activeForm.get()?.render(() => undefined, 30),
    );

    try {
      await waitFor(() =>
        standalone.stdout.output.includes('Configured: OpenAI'),
      );
      await waitFor(() => slash.stdout.output.includes('Configured: OpenAI'));
    } finally {
      standalone.instance.unmount();
      slash.instance.unmount();
    }
  });
});

describe('/config slash command wiring', () => {
  it('registers /config with a form and settings alias', () => {
    registerBuiltinSlashCommands({
      getConfigStores: () => makeFakeSettingsStores().stores,
    });
    const config = listSlashCommands().find((cmd) => cmd.name === 'config');
    expect(config).toEqual(
      expect.objectContaining({
        description: 'View and toggle settings',
        aliases: ['settings'],
        formComponent: expect.any(Function),
      }),
    );
  });

  it('wires the roster and reads through the injected CLI stores', () => {
    const { stores, config } = makeFakeSettingsStores();
    // Seed the git-author config slot the CLI reads from.
    void config.update(WorkspaceStateKey.GIT_MARK_COMMITS, false);

    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    expect(openCliSlashCommandForm('config', '')).toBe(true);
    expect(activeForm.get()?.commandName).toBe('config');

    const props = renderConfigFormProps();
    expect(props.entries?.map((entry) => entry.key)).toEqual(
      CLI_STATE_SETTINGS.map((entry) => entry.key),
    );

    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    expect(props.readValue?.(markCommits)).toBe(false);
  });

  it('persists writes through the accessor to the CLI store', async () => {
    const { stores, config } = makeFakeSettingsStores();
    const props = openConfigFormProps(stores);
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await props.writeValue?.(markCommits, false);

    expect(isStored(config, WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(true);
    expect(props.readValue?.(markCommits)).toBe(false);
  });

  it('emits a deferred command echo before a configuration error', async () => {
    const { stores } = makeFakeSettingsStores();
    const events: string[] = [];
    registerBuiltinSlashCommands({
      getConfigStores: () => stores,
      onError: () => {
        events.push('error');
      },
    });
    openCliSlashCommandForm('config', '', () => events.push('echo'));

    await renderConfigFormProps().onError?.(new Error('write failed'));
    await renderConfigFormProps().onError?.(new Error('write failed again'));

    expect(events).toEqual(['echo', 'error', 'error']);
  });

  it('re-applies git author config so a toggle takes effect this session', async () => {
    const { stores } = makeFakeSettingsStores();
    const props = openConfigFormProps(stores);
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);

    await props.writeValue?.(markCommits, true);
    expect(getGitAuthorEnv().GIT_AUTHOR_NAME).toBe(DEFAULT_GIT_AUTHOR_NAME);

    await props.writeValue?.(markCommits, false);
    expect(getGitAuthorEnv()).toEqual({});
  });

  it('resets a git setting (delete) and re-applies the identity', async () => {
    const { stores, config } = makeFakeSettingsStores();
    const props = openConfigFormProps(stores);
    const authorName = entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME);

    await props.writeValue?.(authorName, 'someone-else');
    expect(isStored(config, WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(true);

    await props.resetValue?.(authorName);
    // The key is deleted, so reads fall back to the default identity.
    expect(isStored(config, WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(false);
    expect(props.readValue?.(authorName)).toBe(DEFAULT_GIT_AUTHOR_NAME);
  });

  it('switches to personal API mode when OpenRouter routing is enabled', async () => {
    resetCliState({
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
    });
    const { stores } = makeFakeSettingsStores();
    const selectedAccessRoutes: CliModelAccessSelection[] = [];
    registerBuiltinSlashCommands({
      getConfigStores: () => stores,
      onModelAccessSelect: (selection) => {
        selectedAccessRoutes.push(selection);
        if (selection.kind === 'subscription-preference') return;
        sessionMeta.set({
          ...sessionMeta.get(),
          apiMode: selection.apiMode,
        });
      },
    });
    openCliSlashCommandForm('config', '');

    const props = renderConfigFormProps();
    const openRouter = entryByKey(GlobalStateKey.USE_OPENROUTER);

    await props.writeValue?.(openRouter, true);

    expect(selectedAccessRoutes).toEqual([
      { kind: 'api-fallback', apiMode: 'personal' },
    ]);
    expect(sessionMeta.get().apiMode).toBe('personal');
    expect(invalidateModelOptionsCache).toHaveBeenCalledOnce();
  });

  it('invalidates model options when OpenRouter routing is disabled or reset', async () => {
    const { stores } = makeFakeSettingsStores();
    const props = openConfigFormProps(stores);
    const openRouter = entryByKey(GlobalStateKey.USE_OPENROUTER);

    await props.writeValue?.(openRouter, false);
    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(1);

    await props.resetValue?.(openRouter);
    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(2);
  });

  it('turns OpenRouter off when Prefer Kimi Code is enabled', async () => {
    const { stores, globalState } = makeFakeSettingsStores();
    await globalState.update(GlobalStateKey.USE_OPENROUTER, true);
    const props = openConfigFormProps(stores);
    const preferKimiCode = entryByKey(GlobalStateKey.KIMI_CODE_PREFER);
    await props.writeValue?.(preferKimiCode, true);

    expect(globalState.get(GlobalStateKey.KIMI_CODE_PREFER)).toBe(true);
    expect(props.readValue?.(entryByKey(GlobalStateKey.USE_OPENROUTER))).toBe(
      false,
    );
    expect(invalidateModelOptionsCache).toHaveBeenCalled();

    // Disabling the preference leaves the OpenRouter toggle untouched.
    await globalState.update(GlobalStateKey.USE_OPENROUTER, true);
    await props.writeValue?.(preferKimiCode, false);
    expect(globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(true);
  });

  it('delegates catalog form rows through the slash form registry', () => {
    const props = openConfigFormProps();
    props.openForm?.('tools');

    expect(activeForm.get()?.commandName).toBe('tools');
  });

  it('provides native linked forms with the shared terminal row budget', () => {
    const props = openConfigFormProps();
    const linkedRows = (name: string): number | undefined =>
      (
        props.formRenderers?.[name]?.(() => undefined) as
          { props?: { availableRows?: number } } | undefined
      )?.props?.availableRows;

    expect(props.availableRows).toBe(20);
    expect(linkedRows('tools')).toBe(20);
    expect(linkedRows('agents')).toBe(20);
    expect(linkedRows('api-keys')).toBe(20);
  });
});
