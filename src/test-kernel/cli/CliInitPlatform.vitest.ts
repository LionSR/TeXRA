// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { initCliPlatform } from '@cli/runtime/initPlatform';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { StateWriteFailed } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  claudeAgentSessionsFor,
  codexThreadsFor,
} from '@tools/agentCliSessionStores';
import { SetupPlatform } from '@tools/setup/platform';

type SignalSpyEvent = 'SIGINT' | 'SIGTERM';
type SignalRegistration = {
  event: SignalSpyEvent;
  kind: 'once' | 'on' | 'removed';
};

/** Records every SIGINT/SIGTERM registration without touching the live
 *  process's real listeners, distinguishing `process.once` (the platform
 *  handler) from `process.on` (the TUI's own handler, installed once Ink
 *  mounts) so a test can assert exactly who owns the signal. Restore only
 *  these two spies (not `vi.restoreAllMocks()`) — this file's shared `mocks.*`
 *  functions are plain `vi.fn()`s, not `vi.spyOn` spies, so a sweeping
 *  restore would strip their `vi.hoisted` implementations instead of
 *  reverting them. */
function spyOnSignalRegistration(): {
  registered: SignalRegistration[];
  restore: () => void;
} {
  const registered: SignalRegistration[] = [];
  const record = (kind: SignalRegistration['kind']) =>
    ((event: string | symbol) => {
      if (event === 'SIGINT' || event === 'SIGTERM') {
        registered.push({ event, kind });
      }
      return process;
    }) as typeof process.once;
  const spies = [
    vi.spyOn(process, 'once').mockImplementation(record('once')),
    vi.spyOn(process, 'on').mockImplementation(record('on')),
    vi.spyOn(process, 'removeListener').mockImplementation(record('removed')),
  ];
  return {
    registered,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

const mocks = vi.hoisted(() => ({
  consoleLogSink: { write: vi.fn() },
  signInCliSupabase: vi.fn(),
  authenticated: false,
  createNodePlatform: vi.fn(() => ({})),
  createNodeWorkspaceRoots: vi.fn(() => ({
    workspace: '/workspace',
    storage: '/workspace/.texra/storage',
    config: { get: (_key: string, def: unknown) => def },
    workspaceState: {},
  })),
  initializeCliSupabaseAuth: vi.fn(),
  initializeNodeRuntimeSkills: vi.fn(),
  getCliSecrets: vi.fn(() => ({ kind: 'cli-secrets' })),
  cliGlobalState: { get: vi.fn(), update: vi.fn() },
  tryPlatform: vi.fn(),
  publishPlatform: vi.fn(),
  // Collects the programs registered via the (mocked) lifecycle host's
  // onShutdown so a test can run them and assert the usage-log dispose was
  // wired.
  shutdownHandlers: [] as Array<Effect.Effect<void, unknown>>,
  /** Records the usage-log dispose when its program runs. */
  disposeUsageLog: vi.fn(),
}));

vi.mock('@cli/runtime/supabaseAuth', async () => {
  const { Effect } = await import('effect');
  const { fakeSupabaseAuth } = await import('@test/support/fakeSupabaseAuth');
  return {
    initializeCliSupabaseAuth: mocks.initializeCliSupabaseAuth,
    signInCliSupabase: mocks.signInCliSupabase,
    // The runtime install's account plane, steerable per test: the probe
    // reads the flag when it runs, not when the plane is built.
    ensureCliSupabaseAuth: () =>
      fakeSupabaseAuth({
        authenticated: Effect.suspend(() =>
          Effect.succeed(mocks.authenticated),
        ),
      }),
  };
});

vi.mock('@logger/logSink', () => ({
  consoleLogSink: mocks.consoleLogSink,
  setLogSink: vi.fn(),
}));

vi.mock('@logger/logUtils', () => ({
  createLog: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  isDebugModeEnabled: vi.fn(() => false),
  setDebugModeConfig: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@platform/platform', () => ({
  initPlatform: mocks.publishPlatform,
  tryPlatform: mocks.tryPlatform,
  platform: () => ({
    config: { get: (_key: string, def: unknown) => def },
    globalState: mocks.cliGlobalState,
  }),
}));

// initCliPlatform delegates shared Node-host construction and runtime wiring to
// nodeHost; stub it so the test exercises only the CLI-specific wiring and
// feature registration does not run twice across cases.
vi.mock('@platform/defaults/nodeHost', () => ({
  createNodePlatform: mocks.createNodePlatform,
  createNodeWorkspaceRoots: mocks.createNodeWorkspaceRoots,
  initializeNodeRuntimeSkills: mocks.initializeNodeRuntimeSkills,
}));

// The two lifecycle arms are Effects the host runs, so the doubles answer
// with one rather than `undefined`. `dispose` records when its program runs,
// not when the host builds it: the shutdown registration holds the program.
vi.mock('@telemetry/UsageLogService', async () => {
  const { Effect: effect } = await import('effect');
  return {
    UsageLogService: {
      initialize: vi.fn(() => effect.void),
      dispose: () => effect.sync(mocks.disposeUsageLog),
    },
  };
});

// First-init dependencies: only exercised when tryPlatform() returns undefined.
// Most cases keep tryPlatform truthy and skip this block, so these stubs are
// inert there and only drive the "first init" tests below.
vi.mock('@platform/defaults/lifecycleHost', async () => {
  const { Effect: effect } = await import('effect');
  return {
    createLifecycleHost: () => ({
      onShutdown: (_phase: unknown, handler: Effect.Effect<void, unknown>) => {
        mocks.shutdownHandlers.push(handler);
        return { dispose: vi.fn() };
      },
      runShutdown: effect.void,
    }),
  };
});

vi.mock('@platform/defaults/nodeWorkspace', () => ({
  canonicalizeWorkspacePath: vi.fn((workspacePath: string) => workspacePath),
}));

vi.mock('@cli/runtime/cliStateStores', () => ({
  openCliWorkspaceState: vi.fn(() =>
    Effect.succeed({
      workspaceState: {},
      storage: {
        getStoragePath: () => '/workspace/.texra/storage',
        getGlobalStoragePath: () => '/tmp/texra-global',
      },
    }),
  ),
}));

// The global state store the CLI's process-runtime install opens before it
// installs the runtime that serves it: this suite runs that real install, so
// the open is what it stubs.
vi.mock('@controllers/session/appStateStore', () => ({
  openAppStateStore: vi.fn(() => Effect.succeed(mocks.cliGlobalState)),
}));

vi.mock('@cli/runtime/cliSecrets', () => ({
  getCliSecrets: mocks.getCliSecrets,
}));

function cliContext(
  overrides: Partial<Parameters<typeof initCliPlatform>[0]> = {},
): Parameters<typeof initCliPlatform>[0] {
  return {
    cwd: '/tmp/project',
    resourcesPath: '/tmp/resources',
    version: '0.0.0-test',
    quietLogs: true,
    skillSourceOptions: {},
    // The provider the startup read opens and this init installs as the
    // roots' config, handed over rather than opened a second time here.
    config: new MemoryConfigProvider(),
    ...overrides,
  };
}

function stubGlobalState(
  get: (key: string, defaultValue: unknown) => unknown = (_key, def) => def,
) {
  return { get: vi.fn(get), update: vi.fn(() => Effect.void) };
}

/**
 * Each signal-ownership test must observe installation from a clean slate:
 * `installCliShutdownSignalHandlers` guards on an idempotent, module-level
 * `shutdownHandlersInstalled` flag, so the module needs a fresh import
 * (`vi.resetModules()`), and the process-listener spies must be restored
 * afterwards (never `vi.restoreAllMocks()` — see spyOnSignalRegistration).
 */
async function withFreshSignalCapture(
  run: (context: {
    registered: SignalRegistration[];
    initPlatform: typeof import('@cli/runtime/initPlatform');
  }) => Promise<void>,
): Promise<void> {
  vi.resetModules();
  const { registered, restore } = spyOnSignalRegistration();
  try {
    await run({
      registered,
      initPlatform: await import('@cli/runtime/initPlatform'),
    });
  } finally {
    restore();
  }
}

describe('CLI platform init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shutdownHandlers.length = 0;
    mocks.cliGlobalState.get.mockReset();
    mocks.cliGlobalState.get.mockImplementation(
      (_key, defaultValue) => defaultValue,
    );
    mocks.cliGlobalState.update.mockReset();
    // The store's write is an Effect the callers compose, so the double's
    // default is one too; a bare `vi.fn()` returns undefined and `yield*`
    // fails on it.
    mocks.cliGlobalState.update.mockReturnValue(Effect.void);
    mocks.tryPlatform.mockReset();
    mocks.tryPlatform.mockReturnValue({ globalState: stubGlobalState() });
    mocks.authenticated = false;
  });

  it('wires usage logging on first platform init', async () => {
    // tryPlatform() === undefined drives the once-per-process first-init block.
    mocks.tryPlatform.mockReturnValue({ globalState: stubGlobalState() });
    mocks.tryPlatform.mockReturnValueOnce(undefined);

    await Effect.runPromise(
      initCliPlatform(
        cliContext({ version: '1.2.3', installSignalHandlers: false }),
      ),
    );

    expect(vi.mocked(UsageLogService.initialize)).toHaveBeenCalledWith(
      expect.anything(),
      {},
      '1.2.3',
      'cli',
    );

    // The dispose handler must be registered on shutdown so queued entries flush.
    expect(mocks.disposeUsageLog).not.toHaveBeenCalled();
    for (const handler of mocks.shutdownHandlers)
      await Effect.runPromise(handler);
    expect(mocks.disposeUsageLog).toHaveBeenCalled();
  });

  it('retries after seed failure without publishing platform, session, or signals', async () => {
    await withFreshSignalCapture(async ({ registered, initPlatform }) => {
      mocks.tryPlatform.mockReset();
      mocks.tryPlatform
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined)
        .mockReturnValue({ globalState: stubGlobalState() });
      const storeFailure = new Error(
        'disabled-tool defaults could not be seeded',
      );
      // The store is the failure's author now, so the double fails with the
      // store's own tagged error rather than a bare rejection.
      mocks.cliGlobalState.update.mockReturnValueOnce(
        Effect.fail(
          new StateWriteFailed({
            key: GlobalStateKey.DISABLED_TOOLS,
            message: storeFailure.message,
            cause: storeFailure,
          }),
        ),
      );

      // The seed's own typed failure, carrying the store's rejection.
      await expect(
        Effect.runPromise(initPlatform.initCliPlatform(cliContext())),
      ).rejects.toMatchObject({
        _tag: 'StateWriteFailed',
        key: GlobalStateKey.DISABLED_TOOLS,
        cause: storeFailure,
      });

      const { tryDefaultSession } = await import('@agent/runtime');
      expect(mocks.publishPlatform).not.toHaveBeenCalled();
      expect(tryDefaultSession()).toBeUndefined();
      expect(registered).toEqual([]);

      await expect(
        Effect.runPromise(initPlatform.initCliPlatform(cliContext())),
      ).resolves.toEqual(expect.objectContaining({ roots: expect.anything() }));
      expect(mocks.publishPlatform).toHaveBeenCalledOnce();
      expect(tryDefaultSession()).toBeUndefined();
      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
      ]);
    });
  });

  it('registers the agent shutdown drain on first platform init', async () => {
    // Regression: the CLI was the one host that never registered these, so a
    // background `bash` run (spawned detached, in its own process group) and
    // any live codex / claude_agent session outlived `texra` as orphans.
    // Asserted through the real `registerAgentShutdownHandler` and its
    // observable effect on shutdown, not by mocking the @agent module. The
    // init installs the process runtime the session graph runs on, so the
    // session is built after it, not on a runtime an earlier case's shutdown
    // disposed.
    mocks.tryPlatform.mockReturnValueOnce(undefined);
    await Effect.runPromise(
      initCliPlatform(cliContext({ installSignalHandlers: false })),
    );
    const session = createTestSession();
    const interruptCodex = vi
      .spyOn(codexThreadsFor(session.runs), 'interruptAll')
      .mockImplementation(() => {});
    const interruptClaude = vi
      .spyOn(claudeAgentSessionsFor(session.runs), 'interruptAll')
      .mockImplementation(() => {});

    try {
      // Registration alone must not interrupt anything; the drain belongs to
      // the CLI lifecycle host every exit path runs (bin/texra.ts's finally,
      // the signal handlers, the TUI's exitNow).
      expect(interruptCodex).not.toHaveBeenCalled();
      for (const handler of mocks.shutdownHandlers)
        await Effect.runPromise(handler);
      expect(interruptCodex).toHaveBeenCalledOnce();
      expect(interruptClaude).toHaveBeenCalledOnce();
    } finally {
      interruptCodex.mockRestore();
      interruptClaude.mockRestore();
    }
  });

  it('wires setup sign-in to the existing CLI login implementation', async () => {
    mocks.authenticated = true;
    mocks.signInCliSupabase.mockReturnValue(
      Effect.succeed({ account: { label: 'User' } }),
    );

    // The runtime this root installed, as it hands it back: the root's own
    // local, not a process-wide read.
    const { runtime } = await Effect.runPromise(initCliPlatform(cliContext()));

    const setup = await runtime.runPromise(Effect.service(SetupPlatform));
    expect(setup.host).toBe('cli');
    expect(await runtime.runPromise(setup.signIn())).toBe(true);
    expect(mocks.signInCliSupabase).toHaveBeenCalledOnce();
    expect(mocks.signInCliSupabase).toHaveBeenCalledWith(runtime, {
      openBrowser: true,
    });
  });
});

// Regression for the HIGH-severity chat TUI signal race: `texra chat`/
// `setup`/`resume` are the REAL interactive entry points — all
// three eventually hand control to runChatTui.tsx's `runChat()`, which installs
// its own SIGINT/SIGTERM handlers once Ink mounts and owns teardown from
// there (terminal-mode restore, persistence drain, then the same
// runCliPlatformShutdownSequence the platform handler would have run). Before
// this fix, every one of those call sites also called plain `initCliPlatform`
// (default `installSignalHandlers: true`), so the platform's own
// `process.once('SIGINT'/'SIGTERM', ...)` handler installed too — two
// independent async shutdown chains reacting to the same signal, racing on
// whose `process.exit()` wins and leaving teardown order unspecified.
//
// The interactive entries do NOT suppress the platform handler up front (a
// signal during onboarding/model-resolution still needs a graceful handler):
// none of them passes `installSignalHandlers: false`. Instead
// `handOffCliShutdownSignalHandlers()` removes it right at the point the TUI
// installs its own pair, so the two sets are never simultaneously live.
describe('CLI platform interactive signal ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryPlatform.mockReset();
    // First call drives the once-per-process first-init block; later calls see
    // an initialized platform.
    mocks.tryPlatform.mockReturnValueOnce(undefined);
    mocks.tryPlatform.mockReturnValue({
      globalState: stubGlobalState(() => undefined),
    });
  });

  it('an interactive init keeps the platform handler live until an explicit handoff', async () => {
    await withFreshSignalCapture(async ({ registered, initPlatform }) => {
      // The suspension point from the finding: runChat() runs this init, then
      // onboarding/model resolution, before Ink ever mounts and installs its
      // own handlers below. Unlike the pre-handoff-design fix, the platform
      // handler stays registered for that whole window — a signal there still
      // gets a graceful shutdown.
      await Effect.runPromise(initPlatform.initCliPlatform(cliContext()));
      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
      ]);

      // The TUI is about to mount (runChatTui.tsx) — it hands off ownership
      // immediately before installing its own handlers.
      initPlatform.handOffCliShutdownSignalHandlers();
      // Handoff releases the install-order disposers LIFO, so SIGTERM first.
      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
        { event: 'SIGTERM', kind: 'removed' },
        { event: 'SIGINT', kind: 'removed' },
      ]);

      process.on('SIGINT', () => undefined);
      process.on('SIGTERM', () => undefined);

      expect(registered.slice(-2)).toEqual([
        { event: 'SIGINT', kind: 'on' },
        { event: 'SIGTERM', kind: 'on' },
      ]);
    });
  });
});
