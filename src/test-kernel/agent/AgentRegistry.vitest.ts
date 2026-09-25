// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { beforeAll, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import {
  computeAgentOptionsData,
  getAgent,
  getVisibleAgents,
  invalidateRemoteAgentsAfterSignOut,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import { installPluginAgentDirectories } from '@agent/index/BundledAgentDirectories';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { registerAgentDirectoryRoots } from '@frontend/setup';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import {
  AgentDirectories,
  AgentDirectoriesFailed,
  AppState,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import { captureLogEntries } from '@test/support/logSinkCapture';
import type * as vscode from 'vscode';

/**
 * A catalog program over the process's global storage view. This suite's fake
 * agent directories answer `custom()` from the packaged path, so nothing here
 * reads the view the readers name in their requirements.
 */
function onGlobalStorage<A, E>(
  program: Effect.Effect<A, E, AgentCatalogServices>,
): Effect.Effect<A, E> {
  return Effect.provide(
    program,
    Layer.mergeAll(
      unusedGlobalStorageFs(),
      nodePlatformLayer,
      testHttpClientLayer,
      AgentDirectories.layer(mutableAgentDirectories),
      AppState.layer(new FakeStateStore()),
    ),
  );
}

const { listRemoteAgents, ORCHESTRATOR_AGENT } = vi.hoisted(() => {
  const ORCHESTRATOR_AGENT = {
    id: 'remote-lead',
    name: 'remoteLead',
    description: 'Remote team root',
    tools: ['delegate_agent'],
    agentCategory: 'toolUse',
  };
  return {
    ORCHESTRATOR_AGENT,
    listRemoteAgents: vi.fn(),
  };
});

const registerExternalRoot = vi.hoisted(() => vi.fn());

vi.mock('@agent/remote/remoteAgentList', () => ({
  listRemoteAgents,
}));

vi.mock('@utils/files/externalRoots', () => ({
  registerExternalRoot,
}));

const BUILTIN_AGENTS_DIR = resolve(
  REPO_ROOT,
  'packages/extension/resources/agents',
);
const BUILTIN_TOOL_USE_AGENTS_DIR = resolve(
  REPO_ROOT,
  'packages/extension/resources/tool_use_agents',
);

function testAgentDirectories(
  overrides: Partial<AgentDirectoriesPort> = {},
): AgentDirectoriesPort {
  return {
    custom: () => Effect.sync(() => ''),
    customConfigured: () => Effect.succeed(false),
    builtIn: () => Effect.sync(() => BUILTIN_AGENTS_DIR),
    builtInToolUse: () => Effect.sync(() => BUILTIN_TOOL_USE_AGENTS_DIR),
    ...overrides,
  };
}

let activeAgentDirectories: AgentDirectoriesPort = testAgentDirectories();

const mutableAgentDirectories: AgentDirectoriesPort = {
  custom: () => activeAgentDirectories.custom(),
  customConfigured: () => activeAgentDirectories.customConfigured(),
  builtIn: () => activeAgentDirectories.builtIn(),
  builtInToolUse: () => activeAgentDirectories.builtInToolUse(),
};

/** Point the platform at the real bundled agent YAMLs, overriding any dir. */
function useAgentDirectories(
  overrides: Partial<AgentDirectoriesPort> = {},
): void {
  activeAgentDirectories = testAgentDirectories(overrides);
}

/** Install a fresh fake platform seeded with the given workspace state. */
async function initPlatformWithState(
  workspaceState: Record<string, unknown>,
): Promise<void> {
  await installPlatform(
    { workspaceState },
    { agentDirectories: mutableAgentDirectories },
  );
}

function remoteAgentFixture(id: string, name: string, description: string) {
  return {
    id,
    name,
    description,
    tools: [],
    agentCategory: 'toolUse',
  };
}

describe('agent registry', () => {
  const extensionPath = resolve(REPO_ROOT, 'packages/extension');
  const resourcesPath = resolve(extensionPath, 'resources');
  const globalState = new FakeStateStore();

  beforeEach(() => {
    listRemoteAgents.mockImplementation(() =>
      Effect.succeed([ORCHESTRATOR_AGENT]),
    );
    registerExternalRoot.mockReset();
  });

  beforeAll(async () => {
    // Use the real bundled agent YAMLs rather than synthetic fixtures.
    await initPlatformWithState({});
    useAgentDirectories();
    await Effect.runPromise(onGlobalStorage(refresh({ includeRemote: false })));
  });

  it.effect(
    'skips root registration when called before agent directory initialization',
    () =>
      Effect.gen(function* () {
        expect(
          yield* onGlobalStorage(
            registerAgentDirectoryRoots({
              extensionPath,
            } as vscode.ExtensionContext),
          ),
        ).toBeUndefined();

        expect(registerExternalRoot).toHaveBeenCalledTimes(1);
        expect(registerExternalRoot).toHaveBeenCalledWith(
          resolve(resourcesPath, 'docs', 'agent-creation'),
          expect.objectContaining({ kind: 'agentDocs', writable: false }),
        );
      }),
  );

  it.effect(
    'registers packaged roots and loads the local catalog in startup order',
    () =>
      Effect.gen(function* () {
        agentDirectories.initialize(globalState, resourcesPath, testRuntime());

        expect(
          yield* onGlobalStorage(
            registerAgentDirectoryRoots({
              extensionPath,
            } as vscode.ExtensionContext),
          ),
        ).toBeUndefined();
        expect(
          yield* onGlobalStorage(loadAgents({ includeRemote: false })),
        ).toBeUndefined();

        expect(registerExternalRoot).toHaveBeenCalledWith(
          resolve(resourcesPath, 'agents'),
          expect.objectContaining({ kind: 'builtInWorkflow', writable: false }),
        );
        expect(registerExternalRoot).toHaveBeenCalledWith(
          resolve(resourcesPath, 'tool_use_agents'),
          expect.objectContaining({ kind: 'builtInToolUse', writable: false }),
        );
      }),
  );

  it.effect(
    'pools tool plugin agent directories into the builtInToolUse source',
    () =>
      Effect.gen(function* () {
        installPluginAgentDirectories(resourcesPath, ['lean4']);
        yield* onGlobalStorage(refresh({ includeRemote: false }));
        const lean = getAgent('lean');
        expect(lean?.source).toBe('builtInToolUse');
        expect(lean?.path).toBe(
          resolve(resourcesPath, 'plugins/lean4/agents/lean.yaml'),
        );
        installPluginAgentDirectories(resourcesPath, []);
        yield* onGlobalStorage(refresh({ includeRemote: false }));
        expect(getAgent('lean')).toBeUndefined();
      }).pipe(
        // The install is module state: a failed assertion must not leave the
        // plugin directory installed for the rest of the file.
        Effect.ensuring(
          Effect.sync(() => installPluginAgentDirectories(resourcesPath, [])),
        ),
      ),
  );

  it.effect(
    'keeps the current cache visible while a refresh is pending',
    () => {
      const builtInToolUseDir = createDeferred<void>();
      return Effect.gen(function* () {
        expect(getAgent('assistant')?.name).toBe('assistant');

        useAgentDirectories({
          builtInToolUse: () =>
            Effect.promise(() => builtInToolUseDir.promise).pipe(
              Effect.as(BUILTIN_TOOL_USE_AGENTS_DIR),
            ),
        });

        // startImmediately: the refresh claims the load lane and parks on the
        // gated directory read before the next assertion runs.
        const pendingRefresh = yield* Effect.forkChild(
          onGlobalStorage(refresh({ includeRemote: false })),
          { startImmediately: true },
        );

        expect(getAgent('assistant')?.name).toBe('assistant');

        builtInToolUseDir.resolve();
        yield* Fiber.join(pendingRefresh);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            builtInToolUseDir.resolve();
            useAgentDirectories();
          }),
        ),
      );
    },
  );

  it.effect(
    'forces a new remote fetch after an older initialization settles',
    () => {
      const staleLoadGate = Deferred.makeUnsafe<void>();
      const remoteStarted = Deferred.makeUnsafe<void>();
      return Effect.gen(function* () {
        useAgentDirectories();
        yield* onGlobalStorage(refresh({ includeRemote: false }));

        let remoteCall = 0;
        listRemoteAgents.mockImplementation(() =>
          Effect.gen(function* () {
            remoteCall += 1;
            if (remoteCall === 1) {
              yield* Deferred.succeed(remoteStarted, undefined);
              yield* Deferred.await(staleLoadGate);
              return [remoteAgentFixture('stale-agent', 'staleAgent', 'Stale')];
            }
            return [
              remoteAgentFixture('fresh-agent', 'freshAgent', 'Fresh'),
              // A hosted row left behind for a name the bundle now ships.
              remoteAgentFixture('hosted-orchestrator', 'orchestrator', 'Old'),
            ];
          }),
        );

        const staleInitialization = yield* Effect.forkChild(
          onGlobalStorage(loadAgents({ includeRemote: true })),
        );
        yield* Deferred.await(remoteStarted);
        expect(listRemoteAgents).toHaveBeenCalledOnce();
        // startImmediately: the refresh bumps the epoch and takes the lane tail
        // before the stale load is released.
        const forcedRefresh = yield* Effect.forkChild(
          onGlobalStorage(refresh({ includeRemote: true })),
          { startImmediately: true },
        );

        yield* Deferred.succeed(staleLoadGate, undefined);
        yield* Fiber.join(staleInitialization);
        yield* Fiber.join(forcedRefresh);

        expect(listRemoteAgents).toHaveBeenCalledTimes(2);
        expect(getAgent('freshAgent')?.source).toBe('remote');
        expect(getAgent('staleAgent')).toBeUndefined();
        expect(getAgent('orchestrator')?.source).toBe('builtInToolUse');
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(staleLoadGate, undefined);
            listRemoteAgents.mockReset();
            listRemoteAgents.mockImplementation(() =>
              Effect.succeed([ORCHESTRATOR_AGENT]),
            );
            yield* onGlobalStorage(refresh({ includeRemote: false })).pipe(
              Effect.orDie,
            );
          }),
        ),
      );
    },
  );

  it.effect(
    'rescans locally without refetching or superseding a remote refetch',
    () =>
      Effect.gen(function* () {
        useAgentDirectories();
        yield* onGlobalStorage(refresh({ includeRemote: false }));
        const fetchesBefore = listRemoteAgents.mock.calls.length;
        const remoteStarted = yield* Deferred.make<void>();
        const remoteGate = yield* Deferred.make<void>();
        listRemoteAgents.mockImplementationOnce(() =>
          Deferred.succeed(remoteStarted, undefined).pipe(
            Effect.andThen(Deferred.await(remoteGate)),
            Effect.as([ORCHESTRATOR_AGENT]),
          ),
        );

        const remote = yield* Effect.forkChild(
          onGlobalStorage(refresh({ includeRemote: true })),
        );
        yield* Deferred.await(remoteStarted);
        const local = yield* Effect.forkChild(onGlobalStorage(refresh()), {
          startImmediately: true,
        });
        yield* Deferred.succeed(remoteGate, undefined);
        yield* Fiber.join(remote);
        yield* Fiber.join(local);

        expect(getAgent('remoteLead')?.source === 'remote').toBe(true);
        expect(listRemoteAgents).toHaveBeenCalledTimes(fetchesBefore + 1);
      }),
  );

  it.effect('reloads local-only definitions after sign-out invalidation', () =>
    Effect.gen(function* () {
      useAgentDirectories();
      yield* onGlobalStorage(refresh({ includeRemote: true }));
      expect(getAgent('remoteLead')?.source === 'remote').toBe(true);
      const remoteFetchCount = listRemoteAgents.mock.calls.length;

      yield* onGlobalStorage(invalidateRemoteAgentsAfterSignOut());

      expect(getAgent('remoteLead')?.source === 'remote').toBe(false);
      expect(listRemoteAgents).toHaveBeenCalledTimes(remoteFetchCount);
    }),
  );

  it.effect(
    'removes remote definitions even when the local rebuild fails',
    () => {
      const logs = captureLogEntries();
      return Effect.gen(function* () {
        useAgentDirectories();
        yield* onGlobalStorage(refresh({ includeRemote: true }));
        expect(getAgent('remoteLead')?.source === 'remote').toBe(true);
        useAgentDirectories({
          builtIn: () =>
            Effect.fail(
              new AgentDirectoriesFailed({
                source: 'builtInWorkflow',
                message: 'local catalog unavailable',
                cause: undefined,
              }),
            ),
        });

        // startImmediately: removeRemoteEntries runs in the invalidation's
        // synchronous prefix, which the next assertion reads.
        const invalidation = yield* Effect.forkChild(
          onGlobalStorage(invalidateRemoteAgentsAfterSignOut()),
          { startImmediately: true },
        );
        expect(getAgent('remoteLead')?.source === 'remote').toBe(false);
        expect(yield* Fiber.join(invalidation)).toBeUndefined();
        expect(getAgent('remoteLead')?.source === 'remote').toBe(false);
        expect(
          logs.has(
            'WARN',
            'agentRegistry',
            'Local agent catalog rebuild failed after sign-out',
          ),
        ).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            useAgentDirectories();
            yield* onGlobalStorage(refresh({ includeRemote: false })).pipe(
              Effect.orDie,
            );
            setLogSink(null);
          }),
        ),
        Effect.provide(effectDiagnosticsLayer('Trace')),
      );
    },
  );

  it.effect('fences an in-flight remote load before rebuilding locally', () => {
    const remoteLoad = Deferred.makeUnsafe<void>();
    const localRebuild = createDeferred<void>();
    const remoteStarted = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      useAgentDirectories();
      yield* onGlobalStorage(refresh({ includeRemote: false }));
      let builtInCalls = 0;
      useAgentDirectories({
        builtIn: () =>
          Effect.gen(function* () {
            builtInCalls += 1;
            if (builtInCalls === 2) {
              yield* Effect.promise(() => localRebuild.promise);
            }
            return BUILTIN_AGENTS_DIR;
          }),
      });
      listRemoteAgents.mockImplementationOnce(() =>
        Deferred.succeed(remoteStarted, undefined).pipe(
          Effect.andThen(Deferred.await(remoteLoad)),
          Effect.as([
            remoteAgentFixture(
              'late-remote',
              'lateRemote',
              'Late remote result',
            ),
          ]),
        ),
      );

      const staleLoad = yield* Effect.forkChild(
        onGlobalStorage(loadAgents({ includeRemote: true })),
      );
      yield* Deferred.await(remoteStarted);
      expect(listRemoteAgents).toHaveBeenCalled();

      // startImmediately: the invalidation strips remote entries and takes the
      // lane tail behind the stale load before that load is released.
      const invalidation = yield* Effect.forkChild(
        onGlobalStorage(invalidateRemoteAgentsAfterSignOut()),
        { startImmediately: true },
      );
      yield* Deferred.succeed(remoteLoad, undefined);
      yield* Fiber.join(staleLoad);

      expect(getAgent('lateRemote')).toBeUndefined();
      expect(getAgent('remoteLead')?.source === 'remote').toBe(false);

      localRebuild.resolve();
      yield* Fiber.join(invalidation);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.succeed(remoteLoad, undefined);
          localRebuild.resolve();
          useAgentDirectories();
        }),
      ),
    );
  });

  it.effect('keeps the registry serving when a later refresh fails', () =>
    Effect.gen(function* () {
      expect(getAgent('assistant')?.name).toBe('assistant');

      useAgentDirectories({
        builtInToolUse: () =>
          Effect.fail(
            new AgentDirectoriesFailed({
              source: 'builtInToolUse',
              message: 'refresh failed',
              cause: undefined,
            }),
          ),
      });

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => useAgentDirectories()),
      );

      const failure = yield* Effect.flip(onGlobalStorage(loadAgents()));
      expect(String(failure)).toContain('refresh failed');

      expect(getAgent('assistant')?.name).toBe('assistant');
    }),
  );

  it.effect(
    'includes remote agents in launcher options after local-only startup load',
    () =>
      Effect.gen(function* () {
        yield* onGlobalStorage(refresh({ includeRemote: false }));
        expect(
          (yield* getVisibleAgents(hostStores(), 'toolUse')).map(
            (agent) => agent.name,
          ),
        ).not.toContain('remoteLead');

        const options = yield* onGlobalStorage(
          computeAgentOptionsData(hostStores()),
        );

        expect(options.toolUse.map((option) => option.label)).toContain(
          'remoteLead',
        );
      }).pipe(
        Effect.ensuring(
          onGlobalStorage(refresh({ includeRemote: false })).pipe(Effect.orDie),
        ),
      ),
  );

  it.effect(
    'includes remote agents in launcher options after pending local-only startup load',
    () => {
      const builtInToolUseDir = createDeferred<void>();
      return Effect.gen(function* () {
        useAgentDirectories({
          builtInToolUse: () =>
            Effect.promise(() => builtInToolUseDir.promise).pipe(
              Effect.as(BUILTIN_TOOL_USE_AGENTS_DIR),
            ),
        });

        // startImmediately on both: the refresh claims the load lane and the
        // options read queues behind it, both before the gate opens.
        const pendingRefresh = yield* Effect.forkChild(
          onGlobalStorage(refresh({ includeRemote: false })),
          { startImmediately: true },
        );
        const options = yield* Effect.forkChild(
          onGlobalStorage(computeAgentOptionsData(hostStores())),
          { startImmediately: true },
        );

        builtInToolUseDir.resolve();
        yield* Fiber.join(pendingRefresh);
        const result = yield* Fiber.join(options);

        expect(result.toolUse.map((option) => option.label)).toContain(
          'remoteLead',
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            builtInToolUseDir.resolve();
            useAgentDirectories();
            yield* onGlobalStorage(refresh({ includeRemote: false })).pipe(
              Effect.orDie,
            );
          }),
        ),
      );
    },
  );
});
