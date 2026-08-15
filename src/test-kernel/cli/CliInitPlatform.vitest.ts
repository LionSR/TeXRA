// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import { resolveAndResumeStream } from '@agent/runtime/resolveAndResumeStream';
import { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { SupabaseClient } from '@auth/SupabaseClient';
import { setCliAgentResumeHandler } from '@cli/runtime/agentResume';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import { setOutputChannelFactory } from '@logger/logUtils';
import { MODEL_LIST_VERSION } from '@model/modelOptionsBasic';
import type { StreamTabId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import {
  ClaudeAgentSessions,
  CodexThreads,
} from '@tools/agentCliSessionStores';
import { getSetupPlatform } from '@tools/setup/platform';

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
  signInCliSupabase: vi.fn(),
  bootstrapNodeAgentDirectories: vi.fn(),
  createPlatformAgentDirectories: vi.fn(() => ({
    custom: vi.fn(),
    builtIn: vi.fn(),
    builtInToolUse: vi.fn(),
  })),
  createNodePlatform: vi.fn(() => ({})),
  initializeCliSupabaseAuth: vi.fn(),
  initializeNodeGoalPrompts: vi.fn(),
  initializeNodeRuntimeSkills: vi.fn(),
  initNodeAgentRuntime: vi.fn(),
  serverSideKeyService: {
    setUseIncludedModelAccess: vi.fn(),
  },
  getCliSecrets: vi.fn(() => ({ kind: 'cli-secrets' })),
  cliGlobalState: { get: vi.fn(), update: vi.fn() },
  invalidateModelOptionsCache: vi.fn(),
  tryPlatform: vi.fn(),
  // Collects callbacks registered via the (mocked) lifecycle host's onShutdown
  // so a test can run them and assert the usage-log dispose was wired.
  shutdownHandlers: [] as Array<() => unknown>,
}));

vi.mock('@agent/index/platformAgentDirectories', () => ({
  createPlatformAgentDirectories: mocks.createPlatformAgentDirectories,
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => mocks.serverSideKeyService,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  initializeCliSupabaseAuth: mocks.initializeCliSupabaseAuth,
  signInCliSupabase: mocks.signInCliSupabase,
}));

vi.mock('@logger/logUtils', () => ({
  createChannelWriter: vi.fn(() => vi.fn()),
  createLog: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  initialize: vi.fn(),
  setOutputChannelFactory: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
}));

vi.mock('@platform/platform', () => ({
  initPlatform: vi.fn(),
  tryPlatform: mocks.tryPlatform,
  tryGlobalState: () => mocks.tryPlatform()?.globalState,
  platform: () => ({ config: { get: (_key: string, def: unknown) => def } }),
}));

// initCliPlatform delegates shared Node-host construction and runtime wiring to
// nodeHost; stub it so the test exercises only the CLI-specific wiring and
// feature registration does not run twice across cases.
vi.mock('@platform/defaults/nodeHost', () => ({
  bootstrapNodeAgentDirectories: mocks.bootstrapNodeAgentDirectories,
  createNodePlatform: mocks.createNodePlatform,
  initNodeAgentRuntime: mocks.initNodeAgentRuntime,
  initializeNodeGoalPrompts: mocks.initializeNodeGoalPrompts,
  initializeNodeRuntimeSkills: mocks.initializeNodeRuntimeSkills,
}));

vi.mock('@telemetry/UsageLogService', () => ({
  UsageLogService: { initialize: vi.fn(), dispose: vi.fn() },
}));

// First-init dependencies: only exercised when tryPlatform() returns undefined.
// Most cases keep tryPlatform truthy and skip this block, so these stubs are
// inert there and only drive the "first init" tests below.
vi.mock('@platform/defaults/lifecycleHost', () => ({
  createLifecycleHost: () => ({
    onShutdown: (_phase: unknown, callback: () => unknown) => {
      mocks.shutdownHandlers.push(callback);
      return { dispose: vi.fn() };
    },
    runShutdown: vi.fn(),
  }),
}));

vi.mock('@platform/defaults/jsonStore', () => ({
  JsonStore: { open: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@platform/defaults/jsonConfigProvider', () => ({
  JsonConfigProvider: vi.fn(),
}));

vi.mock('@platform/defaults/nodeFilesystem', () => ({ nodeFilesystem: {} }));

vi.mock('@platform/defaults/nodeWorkspace', () => ({
  createNodeWorkspace: vi.fn(() => ({})),
}));

vi.mock('@cli/runtime/cliStateStores', () => ({
  createCliStateStores: vi.fn().mockResolvedValue({
    globalState: mocks.cliGlobalState,
    workspaceState: {},
    storage: { getGlobalStoragePath: () => '/tmp/texra-global' },
  }),
}));

vi.mock('@cli/runtime/cliSecrets', () => ({
  getCliSecrets: mocks.getCliSecrets,
}));

vi.mock('@cli/runtime/gitAuthor', () => ({ applyCliGitAuthorConfig: vi.fn() }));

vi.mock('@tools/lean/direct/directLspAdapter', () => ({
  registerDirectLeanLanguageServices: vi.fn(),
}));

const isAuthenticatedSpy = vi.spyOn(SupabaseClient, 'isAuthenticated');
const canAccessRemoteAgentCatalogSpy = vi.spyOn(
  SupabaseClient,
  'canAccessRemoteAgentCatalog',
);

function cliContext(
  overrides: Partial<Parameters<typeof initCliPlatform>[0]> = {},
): Parameters<typeof initCliPlatform>[0] {
  return {
    cwd: '/tmp/project',
    resourcesPath: '/tmp/resources',
    version: '0.0.0-test',
    quietLogs: true,
    skillSourceOptions: {},
    ...overrides,
  };
}

function stubGlobalState(
  get: (key: string, defaultValue: unknown) => unknown = (_key, def) => def,
) {
  return { get: vi.fn(get), update: vi.fn() };
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
    mocks.tryPlatform.mockReset();
    mocks.tryPlatform.mockReturnValue({ globalState: stubGlobalState() });
    mocks.bootstrapNodeAgentDirectories.mockResolvedValue(undefined);
    canAccessRemoteAgentCatalogSpy.mockResolvedValue(false);
    mocks.serverSideKeyService.setUseIncludedModelAccess.mockResolvedValue(
      undefined,
    );
  });

  it('uses the configured storage root for CLI secrets', async () => {
    mocks.tryPlatform.mockReturnValueOnce(undefined);

    await initCliPlatform(
      cliContext({
        installSignalHandlers: false,
        storageRoot: '/tmp/texra-storage-root',
      }),
    );

    expect(mocks.getCliSecrets).toHaveBeenCalledWith('/tmp/texra-storage-root');
    expect(mocks.createNodePlatform).toHaveBeenCalledOnce();
    expect(mocks.initNodeAgentRuntime).toHaveBeenCalledOnce();
    expect(mocks.initializeCliSupabaseAuth).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/texra-storage-root',
    );
  });

  it('wires usage logging on first platform init', async () => {
    // tryPlatform() === undefined drives the once-per-process first-init block.
    mocks.tryPlatform.mockReturnValue({ globalState: stubGlobalState() });
    mocks.tryPlatform.mockReturnValueOnce(undefined);

    await initCliPlatform(
      cliContext({ version: '1.2.3', installSignalHandlers: false }),
    );

    expect(vi.mocked(UsageLogService.initialize)).toHaveBeenCalledWith(
      {},
      '1.2.3',
      'cli',
    );

    // The dispose handler must be registered on shutdown so queued entries flush.
    expect(vi.mocked(UsageLogService.dispose)).not.toHaveBeenCalled();
    for (const handler of mocks.shutdownHandlers) await handler();
    expect(vi.mocked(UsageLogService.dispose)).toHaveBeenCalled();
  });

  it('registers the agent shutdown drain on first platform init', async () => {
    // Regression: the CLI was the one host that never registered these, so a
    // background `bash` run (spawned detached, in its own process group) and
    // any live codex / claude_agent session outlived `texra` as orphans.
    // Asserted through the real `registerAgentShutdownHandlers` and its
    // observable effect on shutdown, not by mocking the @agent module.
    const interruptCodex = vi
      .spyOn(CodexThreads, 'interruptAll')
      .mockImplementation(() => {});
    const interruptClaude = vi
      .spyOn(ClaudeAgentSessions, 'interruptAll')
      .mockImplementation(() => {});
    mocks.tryPlatform.mockReturnValueOnce(undefined);

    try {
      await initCliPlatform(cliContext({ installSignalHandlers: false }));

      // Registration alone must not interrupt anything; the drain belongs to
      // the CLI lifecycle host every exit path runs (bin/texra.ts's finally,
      // the signal handlers, the TUI's exitNow).
      expect(interruptCodex).not.toHaveBeenCalled();
      for (const handler of mocks.shutdownHandlers) await handler();
      expect(interruptCodex).toHaveBeenCalledOnce();
      expect(interruptClaude).toHaveBeenCalledOnce();
    } finally {
      interruptCodex.mockRestore();
      interruptClaude.mockRestore();
    }
  });

  it('reconciles the enabled-model list on first platform init', async () => {
    // The enabled-model list lives in shared `~/.texra` state; the CLI used to
    // be the one host that never reconciled it, so a CLI-only user kept
    // retired models until some other host ran.
    mocks.tryPlatform.mockReturnValueOnce(undefined);

    await initCliPlatform(cliContext({ installSignalHandlers: false }));

    expect(mocks.cliGlobalState.update).toHaveBeenCalledWith(
      GlobalStateKey.MODEL_LIST_VERSION,
      MODEL_LIST_VERSION,
    );
  });

  it('invalidates and logs when only Copilot route preferences are cleared', async () => {
    expect(MODEL_CONFIGS.gemini36f?.deprecated).toBe(true);
    mocks.tryPlatform.mockReturnValueOnce(undefined);
    mocks.cliGlobalState.get.mockImplementation((key: string) => {
      if (key === GlobalStateKey.MODEL_LIST_VERSION) return MODEL_LIST_VERSION;
      if (key === GlobalStateKey.ENABLED_MODELS) return ['sonnet5T'];
      if (key === GlobalStateKey.COPILOT_ROUTE_MODELS) {
        return ['gemini36f', 'gemini31p'];
      }
      return undefined;
    });
    mocks.cliGlobalState.update.mockResolvedValue(undefined);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      await initCliPlatform(
        cliContext({ quietLogs: false, installSignalHandlers: false }),
      );

      expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
      expect(mocks.cliGlobalState.update).toHaveBeenCalledWith(
        GlobalStateKey.COPILOT_ROUTE_MODELS,
        ['gemini31p'],
      );
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          'Cleared stale Copilot route preferences: [gemini36f]',
        ),
        expect.any(Function),
      );
    } finally {
      stderrWrite.mockRestore();
      mocks.cliGlobalState.get.mockReset();
      mocks.cliGlobalState.update.mockReset();
    }
  });

  it('marks the operator-terminal console sink as trusted', async () => {
    await initCliPlatform(cliContext({ quietLogs: false }));

    expect(vi.mocked(setOutputChannelFactory)).toHaveBeenCalledWith(null, {
      trusted: true,
    });
  });

  it('installs a CLI agent resume port that delegates to the active handler', async () => {
    mocks.tryPlatform.mockReturnValueOnce(undefined);

    await initCliPlatform(cliContext({ installSignalHandlers: false }));

    type NodePlatformOptions = {
      readonly agentResume: {
        tryResumeStream(
          streamId: StreamTabId,
          recovery?: unknown,
        ): Promise<boolean>;
      };
    };
    const createNodePlatformCalls = mocks.createNodePlatform.mock
      .calls as unknown as Array<[NodePlatformOptions]>;
    const nodePlatformOptions = createNodePlatformCalls[0]?.[0];
    expect(nodePlatformOptions?.agentResume).toBeDefined();
    if (!nodePlatformOptions) throw new Error('expected node platform options');

    const streamId = 'stream:cli-resume' as StreamTabId;
    let releaseResumeState!: () => void;
    const pendingResumeState = new Promise<undefined>((resolve) => {
      releaseResumeState = () => resolve(undefined);
    });
    const pendingResume = resolveAndResumeStream(streamId, {
      interactions: new SessionHostInteractions(),
      streamStatus: { isActiveOrResuming: () => false },
      resolveResumeState: () => pendingResumeState,
      resumeToolUse: vi.fn(async () => false),
      executeWorkflow: vi.fn(async () => {}),
    });

    const tryResumeStream = vi.fn(async () => true);
    const dispose = setCliAgentResumeHandler({
      tryResumeStream,
    });

    try {
      await expect(
        nodePlatformOptions.agentResume.tryResumeStream(streamId),
      ).resolves.toBe(true);
      expect(tryResumeStream).toHaveBeenCalledWith(streamId, undefined);
    } finally {
      dispose();
      releaseResumeState();
      await pendingResume;
    }
  });

  it('bootstraps bundled agents with the CLI version store', async () => {
    mocks.tryPlatform.mockReturnValue({
      globalState: stubGlobalState((key, defaultValue) =>
        key === GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION
          ? '1.2.2'
          : defaultValue,
      ),
    });

    await initCliPlatform(
      cliContext({
        resourcesPath: '/tmp/resources-versioned',
        version: '1.2.3',
      }),
    );

    expect(mocks.initializeNodeGoalPrompts).toHaveBeenCalledWith(
      '/tmp/resources-versioned',
    );
    expect(mocks.bootstrapNodeAgentDirectories).toHaveBeenCalledWith({
      channel: 'cli',
      resourcesPath: '/tmp/resources-versioned',
      currentVersion: '1.2.3',
      versionStateKey: GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION,
    });
  });

  it('keeps included access off when OpenRouter routing is enabled', async () => {
    mocks.tryPlatform.mockReturnValue({
      globalState: stubGlobalState((key, defaultValue) =>
        key === GlobalStateKey.USE_OPENROUTER ? true : defaultValue,
      ),
    });

    await initCliPlatform(cliContext());

    expect(isAuthenticatedSpy).not.toHaveBeenCalled();
    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).toHaveBeenCalledWith(false);
  });

  it('clears OpenRouter when startup explicitly selects included access', async () => {
    const globalState = stubGlobalState((key, defaultValue) =>
      key === GlobalStateKey.USE_OPENROUTER ? true : defaultValue,
    );
    mocks.tryPlatform.mockReturnValue({ globalState });

    await initCliPlatform(cliContext({ apiMode: 'included' }));

    expect(globalState.update).toHaveBeenCalledWith(
      GlobalStateKey.USE_OPENROUTER,
      false,
    );
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).toHaveBeenCalledWith(true);
  });

  it('keeps an explicitly requested included mode selected while signed out', async () => {
    await initCliPlatform(cliContext({ apiMode: 'included' }));

    // The model layer, not startup, decides that these models need a sign-in.
    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).toHaveBeenCalledWith(true);
  });

  it('leaves the stored included-access preference alone when no mode is requested', async () => {
    // The preference lives in shared `~/.texra` state, so deriving it from the
    // current session would let a signed-out CLI launch silently switch other
    // hosts to personal keys.
    await initCliPlatform(cliContext());

    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).not.toHaveBeenCalled();
    expect(isAuthenticatedSpy).not.toHaveBeenCalled();
  });

  it('registers CLI runtime skill sources through the shared Node host helper', async () => {
    await initCliPlatform(
      cliContext({
        skillSourceOptions: {
          includeInterop: true,
          additionalPaths: ['vendor/skills'],
        },
      }),
    );

    expect(mocks.initializeNodeRuntimeSkills).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      resourcesPath: '/tmp/resources',
      skillSourceOptions: {
        includeInterop: true,
        additionalPaths: ['vendor/skills'],
      },
    });
  });

  it('wires setup sign-in to the existing CLI login implementation', async () => {
    canAccessRemoteAgentCatalogSpy.mockResolvedValue(true);
    mocks.signInCliSupabase.mockResolvedValue({ account: { label: 'User' } });

    await initCliPlatform(cliContext());

    expect(getSetupPlatform().host).toBe('cli');
    await expect(getSetupPlatform().signIn()).resolves.toBe(true);
    expect(mocks.signInCliSupabase).toHaveBeenCalledOnce();
    expect(mocks.signInCliSupabase).toHaveBeenCalledWith({ openBrowser: true });
  });
});

// Regression for the HIGH-severity chat TUI signal race: `texra chat`/
// `orchestrate`/`setup`/`resume` are the REAL interactive entry points — all
// four eventually hand control to runChatTui.tsx's `runChat()`, which installs
// its own SIGINT/SIGTERM handlers once Ink mounts and owns teardown from
// there (terminal-mode restore, persistence drain, then the same
// runCliPlatformShutdownSequence the platform handler would have run). Before
// this fix, every one of those call sites also called plain `initCliPlatform`
// (default `installSignalHandlers: true`), so the platform's own
// `process.once('SIGINT'/'SIGTERM', ...)` handler installed too — two
// independent async shutdown chains reacting to the same signal, racing on
// whose `process.exit()` wins and leaving teardown order unspecified.
//
// `initInteractiveCliPlatform` does NOT suppress the platform handler up
// front (a signal during onboarding/model-resolution/the orchestration
// launcher still needs a graceful handler); instead
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
    mocks.bootstrapNodeAgentDirectories.mockResolvedValue(undefined);
  });

  it('initInteractiveCliPlatform keeps the platform handler live until an explicit handoff', async () => {
    await withFreshSignalCapture(async ({ registered, initPlatform }) => {
      // The await-suspension point from the finding: runChat() awaits this
      // init call, then onboarding/model resolution, before Ink ever mounts
      // and installs its own handlers below. Unlike the pre-handoff-design
      // fix, the platform handler stays registered for that whole window —
      // a signal there still gets a graceful shutdown.
      await initPlatform.initInteractiveCliPlatform(cliContext());
      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
      ]);

      // The TUI is about to mount (runChatTui.tsx) — it hands off ownership
      // immediately before installing its own handlers.
      initPlatform.handOffCliShutdownSignalHandlers();
      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
        { event: 'SIGINT', kind: 'removed' },
        { event: 'SIGTERM', kind: 'removed' },
      ]);

      process.on('SIGINT', () => undefined);
      process.on('SIGTERM', () => undefined);

      expect(registered.slice(-2)).toEqual([
        { event: 'SIGINT', kind: 'on' },
        { event: 'SIGTERM', kind: 'on' },
      ]);
    });
  });

  it('a headless call site (plain initCliPlatform) keeps the platform handler installed', async () => {
    await withFreshSignalCapture(async ({ registered, initPlatform }) => {
      await initPlatform.initCliPlatform(cliContext());

      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
      ]);
    });
  });
});
