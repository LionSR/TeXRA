import { setTimeout as sleep } from 'node:timers/promises';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  API_KEY_ENV_NAMES,
  API_KEY_PROVIDER_IDS,
  apiKeySecretName,
  SecretsFailed,
} from '@texra-ai/llm';
import { CliConfigForm } from '@cli/chat/tui/forms/CliConfigForm';
import { formatProviderApiKeySummary } from '@cli/chat/tui/forms/ProviderApiKeyForm';
import { installSlashCommands } from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { openCliSlashCommandForm } from '@cli/chat/tui/commands/slashForms';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import { activeForm } from '@cli/chat/tui/state/formSlot';
import {
  APPROVAL_POLICY_CONFIG_KEY,
  type ApprovalPolicy,
} from '@shared/approvalPolicy';
import type { SurfacedSettingEntry } from '@shared/state/stateSettings';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import {
  createDeferred,
  waitForCondition as waitFor,
} from '@test/support/asyncTestUtils';
import { FakeSecrets } from '@test/support/FakePlatform';
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
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { GITHUB_TOKEN_STORAGE_KEY } from '@texra/tools/github/githubAuth';

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

/** The key every status load reads first: one load, one read of it. */
const FIRST_PROVIDER_KEY = apiKeySecretName(API_KEY_PROVIDER_IDS[0]!);

/**
 * The secret store the rendered form reads and writes through, as a host
 * would pass it. A key-status load reads one key per API-key provider; a
 * test can hold a load's answer, taken when the load started, on a gate it
 * settles later (a rejected gate fails that load), to order the answer
 * against the form's other work.
 */
class KeyStatusSecrets extends FakeSecrets {
  /** The key-status loads started so far. */
  loads = 0;
  private readonly held: Promise<unknown>[] = [];
  private gate: Promise<unknown> = Promise.resolve();

  /** Hold the answer of the next load that has not started yet. */
  holdNextLoad(gate: Promise<unknown>): void {
    this.held.push(gate);
  }

  override get(key: string): Effect.Effect<string | undefined, SecretsFailed> {
    if (!key.startsWith('apiKey.')) return super.get(key);
    if (key === FIRST_PROVIDER_KEY) {
      this.loads += 1;
      this.gate = this.held.shift() ?? Promise.resolve();
    }
    const gate = this.gate;
    return super.get(key).pipe(
      Effect.tap(() =>
        Effect.tryPromise({
          try: () => gate,
          catch: (cause) =>
            new SecretsFailed({
              reason: 'io',
              operation: 'get',
              message: 'The key store could not be read',
              key,
              cause,
            }),
        }),
      ),
    );
  }
}

let formSecrets = new KeyStatusSecrets();

beforeEach(() => {
  formSecrets = new KeyStatusSecrets();
  // The form's runtime reads key variables from the process environment; a
  // blank one counts as unset, so a developer's or CI's own keys never decide
  // a status here.
  for (const name of API_KEY_ENV_NAMES) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  installSlashCommands([]);
  resetCliState();
});

function entryByKey(key: string): SurfacedSettingEntry {
  const entry = TEXRA_SETTINGS.byKey(key);
  if (entry?.surfaces === undefined) {
    throw new Error(`missing catalog entry ${key}`);
  }
  return entry as SurfacedSettingEntry;
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
      stores: makeFakeSettingsStores('cli').stores,
      secrets: formSecrets,
      runtime: testRuntime(),
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
  await waitFor(() => configFormProps.current !== undefined);
  rendered.instance.unmount();
  if (!configFormProps.current) {
    throw new TypeError('Expected /config to render ConfigForm');
  }
  return configFormProps.current;
}

async function openConfigFormProps(
  stores = makeFakeSettingsStores('cli').stores,
): Promise<ConfigFormProps> {
  registerBuiltinSlashCommands({
    secrets: new FakeSecrets(),
    stores,
    runtime: testRuntime(),
    runtimeSession: testDefaultSession(),
    runSession: testSessionOf(testDefaultSession()),
    configStores: stores,
  });
  openCliSlashCommandForm('config', '');
  return renderConfigFormProps();
}

describe('ConfigForm helpers', () => {
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
});

describe('CliConfigForm API-key status lifecycle', () => {
  it('settles a failed initial load to a stable unavailable state', async () => {
    const initial = createDeferred();
    const onError = vi.fn();
    formSecrets.holdNextLoad(initial.promise);
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
    const refreshed = createDeferred();
    const rendered = await renderCliConfigForm();

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('No provider keys set'),
      );
      formSecrets.holdNextLoad(refreshed.promise);
      rendered.stdout.output = '';
      await submitOpenAiApiKey(rendered.stdin, rendered.stdout);
      await waitFor(() => formSecrets.loads === 2);
      expect(formSecrets.values.get(apiKeySecretName('openai'))).toBe(
        'sk-private-test-key',
      );
      expect(rendered.stdout.output).not.toContain('sk-private-test-key');
      refreshed.resolve();
      await waitFor(() =>
        rendered.stdout.output.includes('Configured: OpenAI'),
      );
    } finally {
      rendered.instance.unmount();
    }
  });

  it('keeps a successfully saved key configured when its refresh fails', async () => {
    const refreshed = createDeferred();
    const onError = vi.fn();
    const rendered = await renderCliConfigForm(onError);

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('No provider keys set'),
      );
      formSecrets.holdNextLoad(refreshed.promise);
      rendered.stdout.output = '';
      await submitOpenAiApiKey(rendered.stdin, rendered.stdout);
      await waitFor(() => formSecrets.loads === 2);
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
    // The mount's load read the store before the key was saved, so its
    // stale answer is "no keys"; the refresh read it after.
    const initial = createDeferred();
    const refreshed = createDeferred();
    formSecrets.holdNextLoad(initial.promise);
    formSecrets.holdNextLoad(refreshed.promise);
    const rendered = await renderCliConfigForm();

    try {
      await waitFor(() =>
        rendered.stdout.output.includes('Checking configured keys'),
      );
      await submitOpenAiApiKey(rendered.stdin, rendered.stdout);
      await waitFor(() => formSecrets.loads === 2);
      refreshed.resolve();
      await waitFor(() =>
        rendered.stdout.output.includes('Configured: OpenAI'),
      );
      rendered.stdout.output = '';
      initial.resolve();
      await sleep(20);
      expect(stripAnsi(rendered.stdout.output)).toBe('');
    } finally {
      rendered.instance.unmount();
    }
  });

  it('ignores a pending status response after unmount', async () => {
    const initial = createDeferred();
    const onError = vi.fn();
    formSecrets.holdNextLoad(initial.promise);
    const rendered = await renderCliConfigForm(onError);

    await waitFor(() => formSecrets.loads === 1);
    rendered.instance.unmount();
    rendered.stdout.output = '';
    initial.resolve();
    await sleep(20);
    expect(stripAnsi(rendered.stdout.output)).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });

  // `it.live`, not `it.effect`: the body polls the rendered Ink output with
  // `waitFor`, which needs a clock that actually advances.
  it.live(
    'saves a GitHub token from /config without rendering the secret',
    () =>
      Effect.gen(function* () {
        const rendered = yield* Effect.promise(() => renderCliConfigForm());
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rendered.instance.unmount();
          }),
        );

        yield* Effect.promise(() =>
          waitFor(() => rendered.stdout.output.includes('GitHub token')),
        );
        rendered.stdout.output = '';
        yield* Effect.promise(() =>
          submitGitHubToken(rendered.stdin, rendered.stdout),
        );
        yield* Effect.promise(() =>
          waitFor(() => rendered.stdout.output.includes('Token set')),
        );
        expect(yield* formSecrets.get(GITHUB_TOKEN_STORAGE_KEY)).toBe(
          'ghp_private-test-token',
        );
        expect(rendered.stdout.output).not.toContain('ghp_private-test-token');
      }),
  );
});

// `it.live`, not `it.effect`: mounting the slash-command form polls Ink's
// stdin listeners with `waitFor`, which needs a clock that actually advances.
describe('/config slash command wiring', () => {
  it.live(
    'wires the agent list and reads through the injected CLI stores',
    () =>
      Effect.gen(function* () {
        const { stores, repoState } = makeFakeSettingsStores('cli');
        // Seed the repository slot the CLI reads the git settings from.
        // Awaited, so the read below cannot race the write.
        yield* repoState.update(WorkspaceStateKey.GIT_MARK_COMMITS, false);

        registerBuiltinSlashCommands({
          secrets: new FakeSecrets(),
          stores,
          runtime: testRuntime(),
          runtimeSession: testDefaultSession(),
          runSession: testSessionOf(testDefaultSession()),
          configStores: stores,
        });
        expect(openCliSlashCommandForm('config', '')).toBe(true);
        expect(activeForm.get()?.commandName).toBe('config');

        const props = yield* Effect.promise(() => renderConfigFormProps());
        expect(props.entries.map((entry) => entry.key)).toEqual(
          TEXRA_SETTINGS.cliRows.map((entry) => entry.key),
        );

        const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
        expect(props.readValue(markCommits)).toBe(false);
      }),
  );

  // Regression: `/config` used to persist `texra.approvalPolicy` with a bare
  // `writeSetting`, so the stored value changed while the running session and
  // the status bar kept enforcing the old policy.
  it.live(
    'applies an approval-policy write to the live session, not just the store',
    () =>
      Effect.gen(function* () {
        const { stores, config } = makeFakeSettingsStores('cli');
        const applied: ApprovalPolicy[] = [];
        registerBuiltinSlashCommands({
          secrets: new FakeSecrets(),
          stores,
          runtime: testRuntime(),
          runtimeSession: testDefaultSession(),
          runSession: testSessionOf(testDefaultSession()),
          configStores: stores,
          onProjectApprovalPolicyChanged: (policy) => {
            applied.push(policy);
          },
        });
        openCliSlashCommandForm('config', '');
        const props = yield* Effect.promise(() => renderConfigFormProps());

        yield* props.writeValue(entryByKey(APPROVAL_POLICY_CONFIG_KEY), 'yolo');

        expect(config.get(APPROVAL_POLICY_CONFIG_KEY, 'ask')).toBe('yolo');
        expect(applied).toEqual(['yolo']);
      }),
  );

  it.live('persists writes through the accessor to the CLI store', () =>
    Effect.gen(function* () {
      const { stores, repoState } = makeFakeSettingsStores('cli');
      const props = yield* Effect.promise(() => openConfigFormProps(stores));
      const markCommits = entryByKey(WorkspaceStateKey.GIT_MARK_COMMITS);
      yield* props.writeValue(markCommits, false);

      expect(
        yield* isStored(repoState, WorkspaceStateKey.GIT_MARK_COMMITS),
      ).toBe(true);
      expect(yield* repoState.get(WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(
        false,
      );
    }),
  );

  it.live('resets a git setting by deleting the stored key', () =>
    Effect.gen(function* () {
      const { stores, repoState } = makeFakeSettingsStores('cli');
      const props = yield* Effect.promise(() => openConfigFormProps(stores));
      const authorName = entryByKey(WorkspaceStateKey.GIT_AUTHOR_NAME);

      yield* props.writeValue(authorName, 'someone-else');
      expect(
        yield* isStored(repoState, WorkspaceStateKey.GIT_AUTHOR_NAME),
      ).toBe(true);

      yield* props.resetValue(authorName);
      // The key is deleted, so reads fall back to the default identity.
      expect(
        yield* isStored(repoState, WorkspaceStateKey.GIT_AUTHOR_NAME),
      ).toBe(false);
    }),
  );

  it.live('turns OpenRouter off when Kimi Code subscription is on', () =>
    Effect.gen(function* () {
      const { stores, globalState } = makeFakeSettingsStores('cli');
      yield* globalState.update(GlobalStateKey.USE_OPENROUTER, true);
      const props = yield* Effect.promise(() => openConfigFormProps(stores));
      const preferKimiCode = entryByKey(GlobalStateKey.KIMI_CODE_PREFER);
      yield* props.writeValue(preferKimiCode, true);

      expect(yield* globalState.get(GlobalStateKey.KIMI_CODE_PREFER)).toBe(
        true,
      );
      expect(yield* globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(false);

      // Disabling the preference leaves the OpenRouter toggle untouched.
      yield* globalState.update(GlobalStateKey.USE_OPENROUTER, true);
      yield* props.writeValue(preferKimiCode, false);
      expect(yield* globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(true);
    }),
  );
});
