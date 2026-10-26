// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { beforeAll, describe, expect, vi } from 'vitest';

// Local imports
import { AgentCatalog } from '@agent/index/agentCatalog';
import { installPluginAgentDirectories } from '@agent/index/BundledAgentDirectories';
import {
  AgentDirectories,
  AgentDirectoriesFailed,
  AppState,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createDeferred } from '@test/support/asyncTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import {
  installPlatform,
  storePluginsLayer,
} from '@test/support/setupPlatform';

const registerExternalRoot = vi.hoisted(() => vi.fn());

vi.mock('@utils/files/externalRoots', () => ({
  registerExternalRoot,
}));

const BUILTIN_AGENTS_DIR = resolve(
  REPO_ROOT,
  'packages/extension/resources/agents',
);

function testAgentDirectories(
  overrides: Partial<AgentDirectoriesPort> = {},
): AgentDirectoriesPort {
  return {
    custom: () => Effect.sync(() => ''),
    customConfigured: () => Effect.succeed(false),
    builtIn: () => Effect.sync(() => BUILTIN_AGENTS_DIR),
    ...overrides,
  };
}

let activeAgentDirectories: AgentDirectoriesPort = testAgentDirectories();

const mutableAgentDirectories: AgentDirectoriesPort = {
  custom: () => activeAgentDirectories.custom(),
  customConfigured: () => activeAgentDirectories.customConfigured(),
  builtIn: () => activeAgentDirectories.builtIn(),
};

/**
 * The suite's one catalog, over the process's global storage view. This
 * suite's fake agent directories answer `custom()` from the packaged path, so
 * nothing here reads the view the catalog names in its requirements.
 */
const catalog = Effect.runSync(
  Effect.provide(
    Effect.gen(function* () {
      return yield* AgentCatalog;
    }),
    AgentCatalog.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          unusedGlobalStorageFs(),
          storePluginsLayer,
          nodePlatformLayer,
          testHttpClientLayer,
          AgentDirectories.layer(mutableAgentDirectories),
          AppState.layer(new FakeStateStore()),
        ),
      ),
    ),
  ),
);

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

  beforeAll(async () => {
    // Use the real bundled agent YAMLs rather than synthetic fixtures.
    await initPlatformWithState({});
    useAgentDirectories();
    await Effect.runPromise(catalog.refresh);
  });

  it.effect('pools tool plugin agent directories into the builtIn source', () =>
    Effect.gen(function* () {
      installPluginAgentDirectories(resourcesPath, ['lean4']);
      yield* catalog.refresh;
      const lean = catalog.get('lean');
      expect(lean?.source).toBe('builtIn');
      expect(lean?.path).toBe(
        resolve(resourcesPath, 'plugins/lean4/agents/lean.yaml'),
      );
      installPluginAgentDirectories(resourcesPath, []);
      yield* catalog.refresh;
      expect(catalog.get('lean')).toBeUndefined();
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
      const builtInDir = createDeferred<void>();
      return Effect.gen(function* () {
        expect(catalog.get('assistant')?.name).toBe('assistant');

        useAgentDirectories({
          builtIn: () =>
            Effect.promise(() => builtInDir.promise).pipe(
              Effect.as(BUILTIN_AGENTS_DIR),
            ),
        });

        // startImmediately: the refresh claims the load lane and parks on the
        // gated directory read before the next assertion runs.
        const pendingRefresh = yield* Effect.forkChild(catalog.refresh, {
          startImmediately: true,
        });

        expect(catalog.get('assistant')?.name).toBe('assistant');

        builtInDir.resolve();
        yield* Fiber.join(pendingRefresh);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            builtInDir.resolve();
            useAgentDirectories();
          }),
        ),
      );
    },
  );

  it.effect('keeps the registry serving when a later refresh fails', () =>
    Effect.gen(function* () {
      expect(catalog.get('assistant')?.name).toBe('assistant');

      useAgentDirectories({
        builtIn: () =>
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

      const failure = yield* Effect.flip(catalog.refresh);
      expect(String(failure)).toContain('refresh failed');

      expect(catalog.get('assistant')?.name).toBe('assistant');
    }),
  );
});
