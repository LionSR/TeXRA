// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { beforeAll, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { getAgent, refresh } from '@agent/index/agentRegistry';
import { installPluginAgentDirectories } from '@agent/index/BundledAgentDirectories';
import {
  AgentDirectories,
  AgentDirectoriesFailed,
  AppState,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createDeferred } from '@test/support/asyncTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { texraPlugins } from '@texra/tools/registry';
import { agentCatalogFollower } from '@tools/agentCatalogFollower';
import { ToolRegistry, toolTable } from '@tools/toolTable';

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

const registerExternalRoot = vi.hoisted(() => vi.fn());

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

describe('agent registry', () => {
  const extensionPath = resolve(REPO_ROOT, 'packages/extension');
  const resourcesPath = resolve(extensionPath, 'resources');

  beforeEach(() => {
    registerExternalRoot.mockReset();
  });

  beforeAll(async () => {
    // Use the real bundled agent YAMLs rather than synthetic fixtures.
    await initPlatformWithState({});
    useAgentDirectories();
    await Effect.runPromise(onGlobalStorage(refresh()));
  });

  it.effect(
    'registers the agent directories for every host as the catalog follower is built',
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(Layer.build(agentCatalogFollower)).pipe(
          Effect.provide(
            Layer.mergeAll(
              unusedGlobalStorageFs(),
              nodePlatformLayer,
              testHttpClientLayer,
              AgentDirectories.layer({
                ...mutableAgentDirectories,
                resourcesRoot: resourcesPath,
              }),
              AppState.layer(new FakeStateStore()),
              // TeXRA's plugins, whose bundled agent directories register.
              Layer.succeed(ToolRegistry)(toolTable(texraPlugins())),
            ),
          ),
        );

        expect(registerExternalRoot).toHaveBeenCalledWith(
          resolve(resourcesPath, 'agents'),
          expect.objectContaining({ kind: 'builtInWorkflow', writable: false }),
        );
        expect(registerExternalRoot).toHaveBeenCalledWith(
          resolve(resourcesPath, 'tool_use_agents'),
          expect.objectContaining({ kind: 'builtInToolUse', writable: false }),
        );
        expect(registerExternalRoot).toHaveBeenCalledWith(
          resolve(resourcesPath, 'docs', 'agent-creation'),
          expect.objectContaining({ kind: 'agentDocs', writable: false }),
        );
        expect(registerExternalRoot).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ kind: 'custom', writable: true }),
        );
      }).pipe(
        // The follower installs the plugin agent directories, module state.
        Effect.ensuring(
          Effect.sync(() => installPluginAgentDirectories(resourcesPath, [])),
        ),
      ),
  );

  it.effect('pools tool plugin agent directories into the builtIn source', () =>
    Effect.gen(function* () {
      installPluginAgentDirectories(resourcesPath, ['lean4']);
      yield* onGlobalStorage(refresh());
      const lean = getAgent('lean');
      expect(lean?.source).toBe('builtIn');
      expect(lean?.path).toBe(
        resolve(resourcesPath, 'plugins/lean4/agents/lean.yaml'),
      );
      installPluginAgentDirectories(resourcesPath, []);
      yield* onGlobalStorage(refresh());
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
          onGlobalStorage(refresh()),
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

  it.effect('keeps the registry serving when a later refresh fails', () =>
    Effect.gen(function* () {
      expect(getAgent('assistant')?.name).toBe('assistant');

      useAgentDirectories({
        builtInToolUse: () =>
          Effect.fail(
            new AgentDirectoriesFailed({
              source: 'builtIn',
              message: 'refresh failed',
              cause: undefined,
            }),
          ),
      });

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => useAgentDirectories()),
      );

      const failure = yield* Effect.flip(onGlobalStorage(refresh()));
      expect(String(failure)).toContain('refresh failed');

      expect(getAgent('assistant')?.name).toBe('assistant');
    }),
  );
});
