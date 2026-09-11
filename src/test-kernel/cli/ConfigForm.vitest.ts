import { setTimeout as sleep } from 'node:timers/promises';

import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  buildConfigListItems,
  coerceSettingInput,
  isConfigResetInput,
  settingEditKind,
  validateSettingInput,
} from '@cli/chat/tui/forms/ConfigForm';
import { CliConfigForm } from '@cli/chat/tui/forms/CliConfigForm';
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
import { activeForm, resetCliState } from '@cli/chat/tui/state/cliState';
import {
  API_PROVIDERS,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  ALL_SETTINGS,
  CLI_STATE_SETTINGS,
  DEFAULT_GIT_AUTHOR_NAME,
} from '@shared/schemas';
import type { SurfacedSettingEntry } from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  createDeferred,
  waitForCondition as waitFor,
} from '@test/support/asyncTestUtils';
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

const providerApiKeyRuntime = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));
const githubTokenRuntime = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@cli/runtime/providerApiKey', () => ({
  loadProviderApiKeyStatuses: providerApiKeyRuntime.load,
  saveProviderApiKey: providerApiKeyRuntime.save,
}));
vi.mock('@cli/runtime/githubToken', () => ({
  loadGitHubTokenStatus: githubTokenRuntime.load,
  saveGitHubToken: githubTokenRuntime.save,
  removeGitHubToken: githubTokenRuntime.remove,
}));

type ConfigFormProps = Parameters<
  typeof import('@cli/chat/tui/forms/ConfigForm').ConfigForm
>[0];
const configFormProps = vi.hoisted(() => ({
  current: undefined as ConfigFormProps | undefined,
}));
// Record the props `/config` hands the real form, so the wiring tests can call
// its read/write/reset callbacks without walking the menus keypress by keypress.
vi.mock('@cli/chat/tui/forms/ConfigForm', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/chat/tui/forms/ConfigForm')>();
  return {
    ...actual,
    ConfigForm: (props: ConfigFormProps) => {
      configFormProps.current = props;
      return actual.ConfigForm(props);
    },
  };
});

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

beforeEach(() => {
  providerApiKeyRuntime.load.mockReset();
  providerApiKeyRuntime.load.mockResolvedValue(apiKeyStatuses());
  providerApiKeyRuntime.save.mockReset();
  providerApiKeyRuntime.save.mockResolvedValue(undefined);
  githubTokenRuntime.load.mockReset();
  githubTokenRuntime.load.mockResolvedValue('none');
  githubTokenRuntime.save.mockReset();
  githubTokenRuntime.save.mockResolvedValue(undefined);
  githubTokenRuntime.remove.mockReset();
  githubTokenRuntime.remove.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  resetCliState();
});

/** A shape `/config` cannot edit inline, used by the read-only assertions. */
const RECORD_ENTRY: SurfacedSettingEntry = {
  key: 'texra.example.record',
  schema: z.record(z.string(), z.string()).prefault({}),
  description: 'A record setting with no inline editor.',
  category: 'example',
  slots: { cli: 'workspaceState' },
  honoredBy: { cli: { reader: 'src/tools/toolAvailability.ts' } },
  surfaces: { cliConfig: true },
};

function entryByKey(key: string): SurfacedSettingEntry {
  const entry = ALL_SETTINGS.find(
    (candidate): candidate is SurfacedSettingEntry =>
      candidate.key === key && candidate.surfaces !== undefined,
  );
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

async function submitGitHubToken(
  stdin: FakeStdin,
  stdout: FakeStdout,
  token = 'ghp_private-test-token',
): Promise<void> {
  stdin.write('3');
  await waitFor(() => stdout.output.includes('Set token'));
  stdin.write('1');
  await waitFor(() => stdout.output.includes('Set GitHub token'));
  stdin.write(token);
  stdin.write('\r');
}

/** Mount the open `/config` form once and return the props it gave ConfigForm. */
async function renderConfigFormProps(): Promise<ConfigFormProps> {
  configFormProps.current = undefined;
  const rendered = await renderInkElement(
    activeForm.get()?.render(() => undefined, 20),
  );
  rendered.instance.unmount();
  if (!configFormProps.current) {
    throw new TypeError('Expected /config to render ConfigForm');
  }
  return configFormProps.current;
}

async function openConfigFormProps(
  stores = makeFakeSettingsStores().stores,
): Promise<ConfigFormProps> {
  registerBuiltinSlashCommands({ getConfigStores: () => stores });
  openCliSlashCommandForm('config', '');
  return renderConfigFormProps();
}

describe('ConfigForm helpers', () => {
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

  it('marks an unsupported schema kind read-only', () => {
    expect(settingEditKind(RECORD_ENTRY)).toBe('readonly');
    const [item] = buildConfigListItems([RECORD_ENTRY], () => ({}));
    expect(item).toMatchObject({ disabled: true });
    expect(item?.description).toContain('read-only');
  });
});

describe('CliConfigForm API-key status lifecycle', () => {
  it('renders initial loading and then configured status from the resolved request', async () => {
    const initial = createDeferred<Record<ApiProvider, ApiKeyStatus>>();
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
    const initial = createDeferred<Record<ApiProvider, ApiKeyStatus>>();
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
    const refreshed = createDeferred<Record<ApiProvider, ApiKeyStatus>>();
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
    const refreshed = createDeferred<Record<ApiProvider, ApiKeyStatus>>();
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
    const initial = createDeferred<Record<ApiProvider, ApiKeyStatus>>();
    const refreshed = createDeferred<Record<ApiProvider, ApiKeyStatus>>();
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
    const initial = createDeferred<Record<ApiProvider, ApiKeyStatus>>();
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

  it('saves a GitHub token from /config without rendering the secret', async () => {
    githubTokenRuntime.load
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('secret');
    const rendered = await renderCliConfigForm();

    try {
      await waitFor(() => rendered.stdout.output.includes('GitHub token'));
      rendered.stdout.output = '';
      await submitGitHubToken(rendered.stdin, rendered.stdout);
      await waitFor(() => githubTokenRuntime.save.mock.calls.length === 1);
      expect(githubTokenRuntime.save).toHaveBeenCalledWith(
        'ghp_private-test-token',
      );
      expect(rendered.stdout.output).not.toContain('ghp_private-test-token');
      await waitFor(() => rendered.stdout.output.includes('Token set'));
    } finally {
      rendered.instance.unmount();
    }
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
  it('wires the roster and reads through the injected CLI stores', async () => {
    const { stores, config } = makeFakeSettingsStores();
    // Seed the git-author config slot the CLI reads from.
    void config.update(WorkspaceStateKey.GIT_MARK_COMMITS, false);

    registerBuiltinSlashCommands({ getConfigStores: () => stores });
    expect(openCliSlashCommandForm('config', '')).toBe(true);
    expect(activeForm.get()?.commandName).toBe('config');

    const props = await renderConfigFormProps();
    expect(props.entries.map((entry) => entry.key)).toEqual(
      CLI_STATE_SETTINGS.map((entry) => entry.key),
    );

    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    expect(props.readValue(markCommits)).toBe(false);
  });

  // Regression: `/config` used to persist `texra.approvalPolicy` with a bare
  // `writeSetting`, so the stored value changed while the running session and
  // the status bar kept enforcing the old policy.
  it('applies an approval-policy write to the live session, not just the store', async () => {
    const { stores, config } = makeFakeSettingsStores();
    const applied: TexraApprovalPolicy[] = [];
    registerBuiltinSlashCommands({
      getConfigStores: () => stores,
      onApprovalPolicySelect: (policy) => {
        applied.push(policy);
      },
    });
    openCliSlashCommandForm('config', '');
    const props = await renderConfigFormProps();

    await props.writeValue(
      entryByKey(TEXRA_APPROVAL_POLICY_CONFIG_KEY),
      'yolo',
    );

    expect(config.get(TEXRA_APPROVAL_POLICY_CONFIG_KEY, 'ask')).toBe('yolo');
    expect(applied).toEqual(['yolo']);
  });

  it('persists writes through the accessor to the CLI store', async () => {
    const { stores, config } = makeFakeSettingsStores();
    const props = await openConfigFormProps(stores);
    const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
    await props.writeValue(markCommits, false);

    expect(isStored(config, WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(true);
    expect(props.readValue(markCommits)).toBe(false);
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

    await (await renderConfigFormProps()).onError?.(new Error('write failed'));
    await (
      await renderConfigFormProps()
    ).onError?.(new Error('write failed again'));

    expect(events).toEqual(['echo', 'error', 'error']);
  });

  it('resets a git setting by deleting the stored key', async () => {
    const { stores, config } = makeFakeSettingsStores();
    const props = await openConfigFormProps(stores);
    const authorName = entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME);

    await props.writeValue(authorName, 'someone-else');
    expect(isStored(config, WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(true);

    await props.resetValue(authorName);
    // The key is deleted, so reads fall back to the default identity.
    expect(isStored(config, WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(false);
    expect(props.readValue(authorName)).toBe(DEFAULT_GIT_AUTHOR_NAME);
  });

  it('turns OpenRouter off when Prefer Kimi Code is enabled', async () => {
    const { stores, globalState } = makeFakeSettingsStores();
    await globalState.update(GlobalStateKey.USE_OPENROUTER, true);
    const props = await openConfigFormProps(stores);
    const preferKimiCode = entryByKey(GlobalStateKey.KIMI_CODE_PREFER);
    await props.writeValue(preferKimiCode, true);

    expect(globalState.get(GlobalStateKey.KIMI_CODE_PREFER)).toBe(true);
    expect(props.readValue(entryByKey(GlobalStateKey.USE_OPENROUTER))).toBe(
      false,
    );

    // Disabling the preference leaves the OpenRouter toggle untouched.
    await globalState.update(GlobalStateKey.USE_OPENROUTER, true);
    await props.writeValue(preferKimiCode, false);
    expect(globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(true);
  });
});
