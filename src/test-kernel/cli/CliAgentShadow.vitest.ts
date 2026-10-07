// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { afterAll, beforeAll, describe, expect, vi } from 'vitest';

// Local imports
import { resolveAgentForLaunch } from '@agent/index';
import { refresh } from '@agent/index/agentRegistry';
import {
  applyInitialCliAgentSelection,
  resolveChatToolUseAgent,
} from '@cli/chat/tui/commands/handlers/agentModelCommands';
import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { GlobalStorageFs } from '@platform/rootedFs';
import { FakeStateStore } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import {
  fakeHostAgentDirectories,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
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
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          refresh(),
          GlobalStorageFs,
          {} as RootedFileSystem,
        ).pipe(
          Effect.provideService(AgentDirectories, fakeHostAgentDirectories),
          Effect.provideService(AppState, new FakeStateStore()),
        ),
        Layer.merge(nodePlatformLayer, testHttpClientLayer),
      ),
    );
  });

  afterAll(async () => {
    await cleanupTempDirs(tempDirs);
  });

  effectIt.effect(
    'validates the shadowed name against the entry launch will run',
    () =>
      Effect.gen(function* () {
        const entry = yield* resolveAgentForLaunch(hostStores(), 'assistant');

        expect(entry?.source).toBe('custom');
        expect(entry?.task).not.toBeNull();
        expect(yield* resolveChatToolUseAgent(hostStores(), 'assistant')).toBe(
          entry,
        );
      }),
  );

  effectIt.effect(
    'resolves a source-qualified identifier to that exact source',
    () =>
      Effect.gen(function* () {
        expect(
          (yield* resolveAgentForLaunch(hostStores(), 'builtIn:assistant'))
            ?.source,
        ).toBe('builtIn');
        expect(
          (yield* resolveAgentForLaunch(hostStores(), 'custom:assistant'))
            ?.source,
        ).toBe('custom');
      }),
  );

  // Changing the root agent explicitly is a departure from a team preset, so
  // the selection drops the team slots rather than leaving a preset name
  // pointing at an agent the user replaced.
  effectIt.effect(
    'leaves team mode when the root agent is changed explicitly',
    () =>
      Effect.gen(function* () {
        patchSessionMeta({
          teamName: 'Physicist',
          cliTeamId: 'physicist',
          delegationAgentScope: ['builtIn:polish', 'builtIn:assistant'],
        });
        const context = {
          // The workspace agents slots only gate visibility, which this registry leaves
          // unconfigured, so empty chat slots resolve the same names as the host.
          stores: makeFakeSettingsStores('cli').stores,
          session: {
            runSettled: undefined,
            runCompleted: false,
            stopRequested: false,
          },
        } as Parameters<typeof applyInitialCliAgentSelection>[1];

        yield* applyInitialCliAgentSelection('assistant', context);

        expect(sessionMeta.get()).toMatchObject({ agent: 'assistant' });
        expect(sessionMeta.get().teamName).toBeUndefined();
        expect(sessionMeta.get().cliTeamId).toBeUndefined();
        expect(sessionMeta.get().delegationAgentScope).toBeUndefined();
      }),
  );
  effectIt.effect(
    'preserves the launched agent when selection validation is pending',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { stores } = makeFakeSettingsStores('cli');
        const delayedState = {
          ...stores.globalState,
          get: (key: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* stores.globalState.get(key);
            }),
          update: stores.globalState.update.bind(stores.globalState),
        };
        const session = new TuiSession(() => undefined);
        patchSessionMeta({ agent: 'launched-agent', teamName: 'Physicist' });
        const context = {
          stores: { ...stores, globalState: delayedState },
          session,
        } as Parameters<typeof applyInitialCliAgentSelection>[1];
        const selection = yield* Effect.forkChild(
          applyInitialCliAgentSelection('assistant', context),
        );
        yield* Deferred.await(entered);
        session.markRunPending(Effect.never);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(selection);
        expect(sessionMeta.get()).toMatchObject({
          agent: 'launched-agent',
          teamName: 'Physicist',
        });
        session.clearRunState();
      }),
  );
});
