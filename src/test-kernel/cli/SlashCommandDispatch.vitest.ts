// Test composition imports

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';

// Slash command run dispatch.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  vi,
  type MockInstance,
} from 'vitest';

import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import {
  applyCliModelAccessSelection,
  applyCliProviderApiKey,
} from '@cli/chat/tui/commands/handlers/modelAccessCommands';
import {
  loginFromChat,
  logoutFromChat,
} from '@cli/chat/tui/commands/handlers/loginCommands';
import {
  type SlashCommandContext,
  type SlashCommandOutput,
} from '@cli/chat/tui/commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { installSlashCommands } from '@cli/chat/tui/commands/slashRegistry';
import { tuiUi } from '@cli/chat/tui/hosts/tuiUiHost';
import { transcriptRowHeadline } from '@cli/chat/tui/panes/transcriptEntries';
import { notices, noticesFor } from '@cli/chat/tui/state/transcript';
import {
  CLI_LOCAL_RUN_ID,
  closeForegroundReader,
  foregroundReader,
  patchSessionMeta,
  resetCliState,
  transientNotice,
  selectedRunId,
  focusRun,
} from '@cli/chat/tui/state/cliState';
import { activeForm } from '@cli/chat/tui/state/formSlot';
import * as apiStatus from '@cli/runtime/apiStatus';
import * as subscriptionLogin from '@cli/runtime/subscriptionLogin';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliLogoutTarget } from '@cli/runtime/loginOptions';
import * as modelAccessSelection from '@cli/runtime/modelAccessSelection';
import * as cliProviderKeys from '@cli/chat/tui/hosts/cliProviderKeys';
import * as supabaseAuth from '@cli/runtime/supabaseAuth';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import * as codexSubscription from '@model/codex/codexSubscription';
import { withProcessServices } from '@platform/processRuntime';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  RUN_PHASE,
  type RunId,
  type Plan,
  type RunIdentity,
  type RunPhase,
  type TodoItem,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { RESEARCHER_ACCESS_AUTH } from '@ui/copy/accountAuth';
import type { TranscriptRow } from '@ui/transcript';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

// The runs a case names live in the fold's view: /status reads child
// counts, parent edges, and each stream's phase from there.
const seeded = new Map<RunId, RunView>();
function syncSeededView(): void {
  seedView(viewWith([...seeded.values()]));
}
function ensureRun(
  id: RunId,
  over: Partial<Omit<RunView, 'category'>> = {},
): void {
  const current = seeded.get(id);
  // Held by this terminal, so a focused seed is inside the chat's scope.
  seeded.set(
    id,
    makeRunView({
      ownedHere: true,
      ...(current ?? {}),
      ...over,
      id,
    }) as RunView,
  );
  syncSeededView();
}
beforeAll(bindTestSessionView);
// `/plan` reads the focused run off the session's own fold, `/status` off the
// TUI's projection of it; one seeded map answers both.
beforeEach(() => {
  vi.spyOn(testDefaultSession(), 'runView').mockImplementation((id) =>
    seeded.get(id),
  );
});
afterEach(() => {
  installSlashCommands([]);
  seeded.clear();
  syncSeededView();
  resetCliState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
/** The focused run's work plan as the fold states it. */
function seedWorkPlan(
  runId: RunId,
  plan: Plan | null,
  todos: readonly TodoItem[],
): void {
  ensureRun(runId);
  seeded.set(runId, {
    ...makeRunView({ id: runId, ownedHere: true }),
    plan,
    todos: [...todos],
  } as RunView);
  syncSeededView();
}
/** A child the fold holds under its parent, as these cases name one. */
type ChildRow = {
  readonly childRunId: RunId;
  readonly agentName: string;
  readonly identity: RunIdentity;
  readonly status?: RunPhase;
};
function seedChildRoster(parentRunId: RunId, rows: readonly ChildRow[]): void {
  ensureRun(parentRunId);
  const parent = seeded.get(parentRunId);
  for (const row of rows) {
    ensureRun(row.childRunId, {
      parentId: parentRunId,
      ancestors: [
        ...(parent?.ancestors ?? []),
        { id: parentRunId, label: parentRunId },
      ],
      label: row.agentName,
      identity: row.identity,
      status: row.status ?? RUN_PHASE.COMPLETED,
    });
  }
}
/**
 * The process stores the built-in commands and the slash context read, the
 * pair the chat entry point threads in from its own platform services.
 */
const services = {
  secrets: new FakeSecrets(),
  stores: makeFakeSettingsStores().stores,
  runtime: testRuntime(),
  runtimeSession: testDefaultSession(),
};

function createSession(): TuiSession {
  return new TuiSession(() => undefined);
}

function mockModelAccessOverview(): void {
  vi.spyOn(apiStatus, 'loadCliModelAccessOverview').mockReturnValue(
    Effect.succeed({
      access: {
        subscriptions: {
          chatgpt: {
            provider: 'chatgpt',
            signedIn: false,
            preferSubscription: false,
          },
          grok: {
            provider: 'grok',
            signedIn: false,
            preferSubscription: false,
          },
        },
        codingPlans: {
          kimiCode: { preferred: false, keySet: false },
          glmCodingPlan: { preferred: false, keySet: false },
        },
        texraSignedIn: false,
      },
      lines: ['model access: Your own API keys'],
      note: undefined,
    }),
  );
}

function createCliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    cwd: '/tmp/workspace',
    mode: 'interactive',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    version: '0.0.0-test',
    ...overrides,
  });
}

function createContext(
  session: TuiSession = createSession(),
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  let approvalPolicy: TexraApprovalPolicy = 'ask';
  return {
    cliContext: createCliContext(),
    session,
    runtimeSession: services.runtimeSession,
    secrets: services.secrets,
    stores: services.stores,
    runtime: testRuntime(),
    processCwd: '/tmp/launcher',
    initialAgent: 'chat',
    initialModel: 'deepseekT',
    requestInputExit: vi.fn(),
    getApprovalPolicy: () => approvalPolicy,
    setApprovalPolicy: (policy) => {
      approvalPolicy = policy;
    },
    resetSession: vi.fn(),
    resumeRun: (_id: RunId) => Effect.void,
    ...overrides,
  };
}

function lastEntryText(runId: RunId = CLI_LOCAL_RUN_ID): string | undefined {
  const last = noticesFor(notices.get(), runId).at(-1)?.row;
  return last && transcriptRowHeadline(last);
}

function localEntries(): readonly TranscriptRow[] {
  return noticesFor(notices.get(), CLI_LOCAL_RUN_ID).map(({ row }) => row);
}

function localEntryPairs(): Array<{ kind: string; text: string }> {
  return localEntries().map((row) => ({
    kind: row.kind,
    text: transcriptRowHeadline(row),
  }));
}

function transcriptJson(): string {
  return JSON.stringify(notices.get());
}

function expectFormOpens(
  line: string,
  commandName: string,
  context: SlashCommandContext = createContext(),
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    expect(yield* dispatchSlash(line, context)).toBe(true);
    expect(activeForm.get()?.commandName).toBe(commandName);
  });
}

/** The dispatcher as the composer runs it: one program on the process
 *  services the composer threads in. */
function dispatchSlash(
  line: string,
  context: SlashCommandContext = createContext(),
): Effect.Effect<boolean, unknown> {
  return withProcessServices(
    services.runtime,
    handleTuiSlashCommand(line, context),
  );
}

/** The account form's sign-out action, as `/login` runs it. */
function logout(target: CliLogoutTarget): Effect.Effect<void, unknown> {
  return withProcessServices(
    services.runtime,
    logoutFromChat(target, services.stores, services.secrets),
  );
}

function silentOutput(): SlashCommandOutput {
  return { appendOutcome: vi.fn(), setNotice: vi.fn(), writeProgress: vi.fn() };
}

/** A sign-in mock whose promise rejects when its abort signal fires. */
/**
 * A sign-in program that never completes on its own and records whether the
 * slash handler's cancellation reached it as fiber interruption.
 */
function interruptibleProgram(): {
  program: Effect.Effect<never>;
  interrupted: () => boolean;
} {
  let interrupted = false;
  return {
    interrupted: () => interrupted,
    program: Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true;
        }),
      ),
    ),
  };
}

/** Let a forked sign-in reach its never-ending program before the interrupt
 *  lands: a few turns of the event loop cover the scheduler. */
const started = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

function mockSignOuts(): {
  signOutSupabase: MockInstance<typeof supabaseAuth.signOutCliSupabase>;
  signOutChatGpt: MockInstance<typeof subscriptionLogin.signOutCliSubscription>;
} {
  const signOutSupabase = vi
    .spyOn(supabaseAuth, 'signOutCliSupabase')
    .mockReturnValue(Effect.void);
  const signOutChatGpt = vi
    .spyOn(subscriptionLogin, 'signOutCliSubscription')
    .mockReturnValue(Effect.succeed({}));
  mockModelAccessOverview();
  return { signOutSupabase, signOutChatGpt };
}

describe('handleTuiSlashCommand', () => {
  it.effect('opens a live work-plan reader for the focused stream', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });
      const context = createContext();

      yield* dispatchSlash('/plan', context);
      expect(transientNotice.get()?.text).toBe('No focused session.');

      const runId = 'plan-reader' as RunId;
      ensureRun(runId);
      focusRun(runId);
      yield* dispatchSlash('/plan', context);
      expect(transientNotice.get()?.text).toBe(
        'The focused session has no work plan.',
      );

      seedWorkPlan(runId, { objective: 'Check every case.' }, [
        {
          content: 'Check the base case',
          activeForm: 'Checking the base case',
          status: 'in_progress',
        },
      ]);
      yield* dispatchSlash('/plan', context);
      expect(foregroundReader.get()).toEqual({ kind: 'workPlan', runId });

      focusRun('another-stream' as RunId);
      expect(foregroundReader.get()).toEqual({ kind: 'workPlan', runId });
      expect(localEntries()).toEqual([]);
      closeForegroundReader();
    }),
  );

  it.effect(
    'adds a lazy command echo before errors even under echo never',
    () =>
      Effect.gen(function* () {
        installSlashCommands([
          {
            pluginId: 'test',
            commands: [
              {
                name: 'unavailable',
                description: 'Unavailable test command',
                echo: 'never',
              },
            ],
          },
        ]);

        yield* dispatchSlash('/unavailable', createContext());

        expect(localEntryPairs()).toEqual([
          { kind: 'user', text: '/unavailable' },
          {
            kind: 'assistant',
            text: '/unavailable is registered but is not available in this CLI view yet.',
          },
        ]);
      }),
  );

  it.effect('threads deferred echo through fallback registered forms', () =>
    Effect.gen(function* () {
      installSlashCommands([
        {
          pluginId: 'test',
          commands: [
            {
              name: 'custom-form',
              description: 'Custom form',
              echo: 'ifPersists',
              formComponent: () => null,
            },
          ],
        },
      ]);

      yield* dispatchSlash('/custom-form', createContext());
      const form = activeForm.get()?.render(() => undefined, 20) as {
        props?: { onPersist?: () => void };
      };
      expect(localEntries()).toEqual([]);

      form.props?.onPersist?.();

      expect(localEntryPairs()).toEqual([
        { kind: 'user', text: '/custom-form' },
      ]);
    }),
  );

  it.effect(
    'queues a host dialog behind an open slash form instead of evicting it',
    () =>
      Effect.gen(function* () {
        installSlashCommands([
          {
            pluginId: 'test',
            commands: [
              {
                name: 'custom-form',
                description: 'Custom form',
                formComponent: () => null,
              },
            ],
          },
        ]);
        yield* dispatchSlash('/custom-form', createContext());

        // The host dialog reachable from a retry card ('k' with no stored
        // key). It must wait for the slot, not overwrite the form the user
        // is filling.
        const dialog = yield* Effect.forkChild(
          tuiUi.input({ prompt: 'API key', password: true }),
        );
        yield* started;
        expect(activeForm.get()?.commandName).toBe('custom-form');

        yield* Fiber.interrupt(dialog);
      }),
  );

  it.effect('discards inline key arguments without recording the secret', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });
      const secret = 'sk-private-test-value';

      yield* expectFormOpens(`/keys ${secret}`, 'key');

      expect(JSON.stringify(activeForm.get())).not.toContain(secret);
      expect(transientNotice.get()?.text).toContain(
        'does not accept a key as an argument',
      );
      expect(transcriptJson()).not.toContain(secret);
    }),
  );

  it.effect(
    'keeps malformed and mistyped key commands out of the transcript',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const context = createContext();
        const malformedSecrets = [
          'sk-equals-private-value',
          'sk-colon-private-value',
          'sk-slash-private-value',
          'sk-concatenated-private-value',
          'sk-transposed-private-value',
        ];
        const typoSecret = 'sk-typo-private-value';

        for (const line of [
          `/key=${malformedSecrets[0]}`,
          `/key:${malformedSecrets[1]}`,
          `/key/${malformedSecrets[2]}`,
          `/key${malformedSecrets[3]}`,
          `/kye:${malformedSecrets[4]}`,
        ]) {
          yield* expectFormOpens(line, 'key', context);
          activeForm.set(undefined);
        }

        yield* expectFormOpens(`/ky ${typoSecret}`, 'key', context);
        const transcript = transcriptJson();
        for (const secret of [...malformedSecrets, typoSecret]) {
          expect(transcript).not.toContain(secret);
        }
      }),
  );

  it.effect('leaves path-like equals input for the agent', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });

      expect(yield* dispatchSlash('/tmp=backup', createContext())).toBe(false);
      expect(yield* dispatchSlash('/keynote.tex', createContext())).toBe(false);
    }),
  );

  it.effect(
    'does not mistake ordinary key-prefixed commands for credential input',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });

        expect(
          yield* dispatchSlash('/keyboard shortcuts', createContext()),
        ).toBe(true);
        expect(activeForm.get()).toBeUndefined();
        expect(transientNotice.get()?.text).toContain(
          'Unknown command with protected input',
        );
      }),
  );

  it.effect(
    'redacts arbitrary concatenated key input without forcing the key form',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const secret = 'keyArbitraryCredentialValue';

        expect(yield* dispatchSlash(`/${secret}`, createContext())).toBe(true);
        expect(activeForm.get()).toBeUndefined();
        expect(transcriptJson()).not.toContain(secret);
      }),
  );

  it.effect(
    'routes the normalized /apikey spelling to the protected form',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });

        yield* expectFormOpens('/apikey private-value', 'key');

        expect(transcriptJson()).not.toContain('private-value');
      }),
  );

  it.effect('uses ChatGPT device-code login from a likely remote shell', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });
      vi.stubEnv('SSH_TTY', '/dev/pts/3');
      vi.spyOn(subscriptionLogin, 'signInCliSubscription').mockReturnValue(
        Effect.succeed({
          signedIn: true,
          email: 'person@example.com',
          label: 'person@example.com',
        }),
      );
      vi.spyOn(codexSubscription, 'setPreferCodexSubscription').mockReturnValue(
        Effect.void,
      );

      const handled = yield* dispatchSlash('/login chatgpt', createContext());

      expect(handled).toBe(true);
      expect(subscriptionLogin.signInCliSubscription).toHaveBeenCalledWith(
        'chatgpt',
        expect.objectContaining({ device: true, noBrowser: false }),
        expect.any(Object),
      );
    }),
  );

  it.effect(
    'cancels an interactive sign-in when its fiber is interrupted',
    () =>
      Effect.gen(function* () {
        const signIn = interruptibleProgram();
        vi.spyOn(subscriptionLogin, 'signInCliSubscription').mockReturnValue(
          signIn.program,
        );

        const fiber = yield* Effect.forkChild(
          withProcessServices(
            services.runtime,
            loginFromChat(
              'chatgpt --no-browser',
              services.stores,
              testRuntime(),
              createCliContext(),
              silentOutput(),
            ),
          ),
        );
        yield* started;
        yield* Fiber.interrupt(fiber);

        expect(signIn.interrupted()).toBe(true);
      }),
  );

  it.effect('explains the shared GLM key routes after saving it', () =>
    Effect.gen(function* () {
      const save = vi
        .spyOn(cliProviderKeys, 'commitCliProviderApiKey')
        .mockReturnValue(Effect.void);

      const notice = yield* applyCliProviderApiKey(
        services.secrets,
        services.stores,
        'glm',
        'glm-secret',
      );

      expect(save).toHaveBeenCalledWith(
        services.secrets,
        services.stores,
        'glm',
        'glm-secret',
      );
      expect(notice).toBe(
        "Tip: the regular GLM endpoint is the default; enable 'Prefer GLM Coding Plan' in `/login` or `/config` to use GLM Coding Plan.",
      );
    }),
  );

  it.effect(
    'cancels a model-access sign-in when its fiber is interrupted',
    () =>
      Effect.gen(function* () {
        const update = interruptibleProgram();
        vi.spyOn(modelAccessSelection, 'updateCliModelAccess').mockReturnValue(
          update.program,
        );
        const fiber = yield* Effect.forkChild(
          withProcessServices(
            services.runtime,
            applyCliModelAccessSelection(
              services.stores,
              {
                kind: 'subscription-preference',
                provider: 'chatgpt',
                state: 'on',
              },
              createContext(),
              silentOutput(),
            ),
          ),
        );
        yield* started;
        yield* Fiber.interrupt(fiber);

        expect(update.interrupted()).toBe(true);
      }),
  );

  it.effect(
    'clears TeXRA and ChatGPT credentials when signing out of all',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const { signOutSupabase, signOutChatGpt } = mockSignOuts();

        yield* logout('all');

        expect(signOutSupabase).toHaveBeenCalledOnce();
        // The provider ids only: each call also carries the session's setting
        // stores, and a `ConfigProvider` in an assertion argument breaks the
        // formatter's own `inspect` probe.
        expect(
          signOutChatGpt.mock.calls.map(([, providerId]) => providerId),
        ).toEqual(['chatgpt', 'grok']);
        const entry = lastEntryText();
        expect(entry).toContain(RESEARCHER_ACCESS_AUTH.signedOut);
        expect(entry).toContain('Signed out of ChatGPT.');
        expect(entry).toContain(
          'ChatGPT subscription disabled for Codex models.',
        );
        expect(entry).not.toContain('\n');
      }),
  );

  it.effect('signs out of only the requested account', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });
      const { signOutSupabase, signOutChatGpt } = mockSignOuts();

      yield* logout('texra');
      expect(signOutSupabase).toHaveBeenCalledOnce();
      expect(signOutChatGpt).not.toHaveBeenCalled();

      yield* logout('chatgpt');
      expect(signOutSupabase).toHaveBeenCalledOnce();
      expect(signOutChatGpt).toHaveBeenCalledOnce();
    }),
  );

  it.effect('reports successful TeXRA sign-out when ChatGPT logout fails', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });
      vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockReturnValue(Effect.void);
      vi.spyOn(subscriptionLogin, 'signOutCliSubscription').mockReturnValue(
        Effect.fail(new Error('Codex logout failed')),
      );
      mockModelAccessOverview();

      yield* logout('all');

      const entry = lastEntryText();
      expect(entry).toContain(RESEARCHER_ACCESS_AUTH.signedOut);
      expect(entry).toContain('ChatGPT sign-out failed: Codex logout failed');
    }),
  );

  it.effect(
    'reports ChatGPT sign-out success when only preference cleanup fails',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockReturnValue(
          Effect.void,
        );
        vi.spyOn(subscriptionLogin, 'signOutCliSubscription').mockReturnValue(
          Effect.succeed({ preferenceError: 'Config write failed' }),
        );
        mockModelAccessOverview();

        yield* logout('all');

        const entry = lastEntryText();
        expect(entry).toContain(RESEARCHER_ACCESS_AUTH.signedOut);
        expect(entry).toContain('Signed out of ChatGPT.');
        expect(entry).toContain(
          'ChatGPT subscription preference could not be disabled: Config write failed',
        );
        expect(entry).not.toContain('ChatGPT sign-out failed');
      }),
  );

  it.effect(
    'treats /quit as the canonical exit command without echoing it',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const session = createSession();
        const requestInputExit = vi.fn();

        const handled = yield* dispatchSlash(
          '/quit',
          createContext(session, { requestInputExit }),
        );

        expect(handled).toBe(true);
        // `stopRequested` is set here and nowhere else on this path: the graceful
        // teardown's wait on the follow-up queue's `idle` depends on it. The
        // interrupt is deliberately NOT raised — the teardown owns that policy.
        expect(session.stopRequested).toBe(true);
        expect(requestInputExit).toHaveBeenCalledOnce();
        expect(selectedRunId.get()).toBeUndefined();
      }),
  );

  it.effect(
    'uses the provided process cwd when formatting /status resume hints',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const session = createSession();
        const runId = '5e0001' as RunId;
        session.runId = runId;
        session.runId = 'exec-1' as RunId;
        focusRun(runId);
        ensureRun(runId, { status: RUN_PHASE.WAITING });

        const handled = yield* dispatchSlash(
          '/status',
          createContext(session, { processCwd: '/tmp/workspace' }),
        );

        expect(handled).toBe(true);
        const statusText = lastEntryText(runId);
        expect(statusText).toContain('resume later with: texra resume exec-1');
        expect(statusText).not.toContain('--cwd');
      }),
  );

  it.effect(
    'reports active children while preserving an idle focused root status',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const session = createSession();
        const rootRunId = '5e0000' as RunId;
        const childRunId = 'stream-child' as RunId;
        focusRun(rootRunId);
        ensureRun(rootRunId, { status: RUN_PHASE.WAITING });
        ensureRun(childRunId, { status: RUN_PHASE.RUNNING });
        seedChildRoster(rootRunId, [
          {
            identity: { kind: 'agent', agent: 'critic' },
            agentName: 'critic',
            status: RUN_PHASE.RUNNING,
            childRunId,
          },
        ]);

        yield* dispatchSlash('/status', createContext(session));

        const statusText = lastEntryText(rootRunId);
        expect(statusText).toContain('status: Idle');
        expect(statusText).toContain('active background tasks: 1');
      }),
  );

  it.effect(
    'counts only running children among mixed direct-children phases',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const session = createSession();
        const rootRunId = '5e0000' as RunId;
        const parentRunId = '5e0a01' as RunId;
        const rootSiblingIds = [
          'stream-root-sibling-1',
          'stream-root-sibling-2',
        ] as RunId[];
        const runningChildId = 'stream-child-running' as RunId;
        const waitingChildId = 'stream-child-waiting' as RunId;
        focusRun(parentRunId);
        for (const runId of rootSiblingIds) {
          ensureRun(runId, { status: RUN_PHASE.RUNNING });
        }
        ensureRun(parentRunId, { status: RUN_PHASE.WAITING });
        ensureRun(runningChildId, { status: RUN_PHASE.RUNNING });
        ensureRun(waitingChildId, { status: RUN_PHASE.WAITING });
        const rosterRow = (
          childRunId: RunId,
          index: number,
          status: RunPhase,
        ) => ({
          identity: { kind: 'agent' as const, agent: `critic-${index}` },
          agentName: `critic-${index}`,
          status,
          startedAt: index + 1,
          childRunId,
        });
        seedChildRoster(rootRunId, [
          rosterRow(parentRunId, 0, RUN_PHASE.WAITING),
          ...rootSiblingIds.map((runId, index) =>
            rosterRow(runId, index + 1, RUN_PHASE.RUNNING),
          ),
        ]);
        seedChildRoster(parentRunId, [
          rosterRow(runningChildId, 3, RUN_PHASE.RUNNING),
          rosterRow(waitingChildId, 4, RUN_PHASE.WAITING),
        ]);

        yield* dispatchSlash('/status', createContext(session));

        const statusText = lastEntryText(rootRunId);
        expect(statusText).toContain('active background tasks: 1');
        expect(statusText).not.toContain('active background tasks: 2');
      }),
  );

  it.effect(
    'reports the owning workflow count while a background task is focused',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const session = createSession();
        const rootRunId = '5e0000' as RunId;
        const focusedChildId = '5ef0c5' as RunId;
        const siblingChildId = 'stream-sibling-child' as RunId;
        focusRun(focusedChildId);
        for (const runId of [focusedChildId, siblingChildId]) {
          ensureRun(runId, { status: RUN_PHASE.RUNNING });
        }
        seedChildRoster(
          rootRunId,
          [focusedChildId, siblingChildId].map((childRunId, index) => ({
            identity: { kind: 'agent' as const, agent: `critic-${index}` },
            agentName: `critic-${index}`,
            status: RUN_PHASE.RUNNING,
            startedAt: index + 1,
            childRunId,
          })),
        );

        yield* dispatchSlash('/status', createContext(session));

        const statusText = lastEntryText(rootRunId);
        expect(statusText).toContain('status: Running');
        expect(statusText).toContain('active background tasks: 2');
      }),
  );

  it.effect(
    'reports the access route that produced the focused stream usage',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const overview = vi.spyOn(apiStatus, 'loadCliModelAccessOverview');
        const session = createSession();
        const runId = '5eacce' as RunId;
        focusRun(runId);
        patchSessionMeta({ model: 'gpt55' });
        // The access route comes off the fold's cumulative usage for the stream.
        ensureRun(runId, {
          status: RUN_PHASE.WAITING,
          usage: {
            inputTokens: 1_000,
            outputTokens: 100,
            cost: 0,
            usageRoute: 'api-key',
          },
        });

        yield* dispatchSlash('/status', createContext(session));

        const statusText = lastEntryText(runId);
        expect(statusText).toContain('model access: Your own API keys');
        expect(statusText).not.toContain('model access: ChatGPT subscription');
        expect(overview).not.toHaveBeenCalled();
      }),
  );

  it.effect('surfaces status lookup failures without rejecting', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });

      const handled = yield* dispatchSlash(
        '/status',
        createContext(createSession(), {
          getApprovalPolicy: () => {
            throw new Error('Credential store unavailable');
          },
        }),
      );

      expect(handled).toBe(true);
      expect(lastEntryText()).toBe('Credential store unavailable');
    }),
  );
});
