// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { Effect, Layer } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { afterAll, beforeAll, describe, expect, vi } from 'vitest';

// Local imports
import {
  AgentCatalog,
  type AgentCatalogShape,
} from '@agent/index/agentCatalog';
import { resolveChatToolUseAgent } from '@cli/chat/tui/commands/handlers/agentModelCommands';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { GlobalStorageFs } from '@platform/rootedFs';
import { FakeStateStore } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  fakeHostAgentDirectories,
  hostStores,
  installPlatform,
  storePluginsLayer,
} from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { documentTaskOf } from '@texra/tools/documents/documentTask';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

// The root-agent selection writes a local notice, whose sink reads the bound
// session view. Nothing here renders a TUI, so the sink stands in for it.
vi.mock('@cli/chat/tui/state/transcript', () => ({
  appendLocalNotice: vi.fn(),
}));

/**
 * A custom agent named `assistant` (a document task) shadows the bundled
 * `assistant`: CLI validation resolves through the launch resolver the run
 * itself uses, so the bare name lands on the custom entry and a
 * source-qualified key reaches the shadowed one.
 */

describe('CLI agent validation with a shadowed name', () => {
  const tempDirs: string[] = [];
  /** The suite's catalog, loaded once the fake host is installed. */
  let catalog: AgentCatalogShape;
  const withCatalog = <A, E>(
    program: Effect.Effect<A, E, AgentCatalog>,
  ): Effect.Effect<A, E> =>
    Effect.provideService(program, AgentCatalog, catalog);

  beforeAll(async () => {
    const customDir = await makeTempDir('texra-cli-shadow-', tempDirs);
    await writeFile(
      resolve(customDir, 'assistant.yaml'),
      [
        'name: assistant',
        'description: Custom workflow agent that shadows a built-in name.',
        'prompt: Custom workflow assistant.',
        'task:',
        '  requests: [Revise the documents.]',
        '',
      ].join('\n'),
    );

    await installPlatform(
      {},
      {
        agentDirectories: {
          custom: () => Effect.sync(() => customDir),
          customConfigured: () => Effect.succeed(false),
          builtIn: () =>
            Effect.sync(() =>
              resolve(REPO_ROOT, 'packages/extension/resources/agents'),
            ),
        },
      },
    );

    // The fake host answers `custom()` from a temp directory of its own, so
    // nothing in this load reaches the global storage view.
    catalog = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const loaded = yield* AgentCatalog;
          yield* loaded.refresh;
          return loaded;
        }),
        AgentCatalog.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(GlobalStorageFs)({} as RootedFileSystem),
              AgentDirectories.layer(fakeHostAgentDirectories),
              AppState.layer(new FakeStateStore()),
              nodePlatformLayer,
              testHttpClientLayer,
              storePluginsLayer,
            ),
          ),
        ),
      ),
    );
  });

  afterAll(async () => {
    await cleanupTempDirs(tempDirs);
  });

  effectIt.effect(
    'validates the shadowed name against the entry launch will run',
    () =>
      withCatalog(
        Effect.gen(function* () {
          const entry = yield* catalog.forLaunch(hostStores(), 'assistant');

          expect(entry?.source).toBe('custom');
          expect(entry && documentTaskOf(entry)).not.toBeNull();
          expect(
            yield* resolveChatToolUseAgent(hostStores(), 'assistant'),
          ).toBe(entry);
        }),
      ),
  );

  effectIt.effect(
    'resolves a source-qualified identifier to that exact source',
    () =>
      withCatalog(
        Effect.gen(function* () {
          expect(
            (yield* catalog.forLaunch(hostStores(), 'builtIn:assistant'))
              ?.source,
          ).toBe('builtIn');
          expect(
            (yield* catalog.forLaunch(hostStores(), 'custom:assistant'))
              ?.source,
          ).toBe('custom');
        }),
      ),
  );
});
