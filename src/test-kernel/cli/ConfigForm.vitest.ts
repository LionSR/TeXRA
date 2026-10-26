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
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
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
      roots: {
        ...testDefaultSession().roots,
        ...makeFakeSettingsStores('cli').stores,
      },
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

describe('CliConfigForm API-key status lifecycle', () => {
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
          runtimeSession: testSessionOf(testDefaultSession()),
          runSession: testSessionOf(testDefaultSession()),
          configRoots: { ...testDefaultSession().roots, ...stores },
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

  // Regression: `/key` mounted the provider picker without a status view, so
  // no row said which providers already had a key.
  it.live('shows each provider key status in the /key picker', () =>
    Effect.gen(function* () {
      const stores = makeFakeSettingsStores('cli').stores;
      registerBuiltinSlashCommands({
        secrets: new FakeSecrets({
          [apiKeySecretName('openai')]: 'sk-private-test-key',
        }),
        stores,
        runtime: testRuntime(),
        runtimeSession: testSessionOf(testDefaultSession()),
        runSession: testSessionOf(testDefaultSession()),
      });
      openCliSlashCommandForm('key', '');
      const rendered = yield* Effect.promise(() =>
        renderInkElement(activeForm.get()?.render(() => undefined, 30)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rendered.instance.unmount()),
      );

      yield* Effect.promise(() =>
        waitFor(() => rendered.stdout.output.includes('OpenAI — Key set')),
      );
      expect(rendered.stdout.output).toContain('Anthropic — Not set');
      expect(rendered.stdout.output).not.toContain('sk-private-test-key');
    }),
  );
});
