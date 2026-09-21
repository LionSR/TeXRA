// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // Both report helpers are Effects, so the doubles answer with one.
  showLoggedErrorMessage: vi.fn(() => Effect.succeed('')),
  showLoggedInfoMessage: vi.fn(() => Effect.succeed('')),
  // The module under test composes `writeSetting`'s Effect, so the standing
  // double is a succeeding one; a test that wants a failure swaps in
  // `Effect.fail` for that call.
  writeSetting: vi.fn((): Effect.Effect<void, Error> => Effect.void),
}));

vi.mock('@shared/config/settingsAccess', async (original) => {
  const actual =
    await original<typeof import('@shared/config/settingsAccess')>();
  return { ...actual, writeSetting: mocks.writeSetting };
});

vi.mock('@frontend/ui/errorHandlingUtils', async (original) => {
  const actual =
    await original<typeof import('@frontend/ui/errorHandlingUtils')>();
  return {
    ...actual,
    showLoggedErrorMessage: mocks.showLoggedErrorMessage,
    showLoggedInfoMessage: mocks.showLoggedInfoMessage,
  };
});

// Local imports
import {
  initializeDefaultSession,
  teardownDefaultSession,
} from '@agent/runtime/sessionGraph';
import {
  withProcessServices,
  type ProcessServices,
} from '@platform/processRuntime';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: undefined });

// The guard asks the window's own session for its workspace folder, so the
// default session has to be the one this suite's empty window opened — the
// import above builds its process default before `setupPlatform` installs
// the folderless roots, which would otherwise leave a workspace behind it.
beforeEach(async () => {
  await testRuntime().runPromise(teardownDefaultSession());
  await testRuntime().runPromise(
    initializeDefaultSession({
      roots: testWorkspaceRoots(),
      transcriptMode: {
        kind: 'ephemeral',
        reason: 'settings workspace guard suite',
      },
    }),
  );
});

type AgentSkillsHarness = {
  updateStateSetting(
    key: string,
    value: unknown,
  ): Effect.Effect<void, Error, ProcessServices>;
  postStateSettingSnapshot: ReturnType<typeof vi.fn>;
};

function createHarness(): AgentSkillsHarness {
  const handler = Object.create(SettingsViewMessageHandler.prototype);
  Reflect.set(handler, 'channel', 'SettingsViewMessageHandler');
  Reflect.set(
    handler,
    'postStateSettingSnapshot',
    vi.fn(() => Effect.void),
  );
  // The guard reads the window's session for its workspace root; the suite's
  // beforeEach reopens the process default against the folderless roots.
  Reflect.set(handler, 'session', testDefaultSession());
  // The shared write path is an Effect program now, settled on the same
  // process runtime the real constructor is handed.
  Reflect.set(handler, 'runtime', testRuntime());
  return handler as AgentSkillsHarness;
}

describe('agent skills workspace guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.effect(
    'restores the switch without writing in an empty VS Code window',
    () =>
      Effect.gen(function* () {
        const handler = createHarness();

        yield* withProcessServices(
          testRuntime(),
          handler.updateStateSetting(AGENT_SKILLS_CONFIG_KEY, false),
        );

        expect(mocks.writeSetting).not.toHaveBeenCalled();
        expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
          'SettingsViewMessageHandler',
          'Open a workspace folder before changing the “Enable skills for tool-use agents” setting.',
        );
        expect(handler.postStateSettingSnapshot).toHaveBeenCalledWith('skills');
      }),
  );

  it.effect('writes user-wide telemetry in an empty VS Code window', () =>
    Effect.gen(function* () {
      const handler = createHarness();

      yield* withProcessServices(
        testRuntime(),
        handler.updateStateSetting('texra.telemetry.enabled', false),
      );

      expect(mocks.showLoggedInfoMessage).not.toHaveBeenCalled();
      expect(mocks.writeSetting).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'texra.telemetry.enabled',
          configTarget: 'global',
        }),
        false,
        expect.any(Object),
        'vscode',
      );
      expect(handler.postStateSettingSnapshot).toHaveBeenCalledWith(
        'telemetry',
      );
    }),
  );

  it.effect('surfaces write failures and restores the owning snapshot', () =>
    Effect.gen(function* () {
      const handler = createHarness();
      const error = new Error('write failed');
      mocks.writeSetting.mockReturnValueOnce(Effect.fail(error));

      yield* withProcessServices(
        testRuntime(),
        handler.updateStateSetting(
          GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
          true,
        ),
      );

      expect(mocks.showLoggedInfoMessage).not.toHaveBeenCalled();
      expect(mocks.showLoggedErrorMessage).toHaveBeenCalledWith(
        'SettingsViewMessageHandler',
        'Failed to update “Keep subagents running”',
        error,
      );
      expect(handler.postStateSettingSnapshot).toHaveBeenCalledWith(
        'multi-agent',
      );
    }),
  );

  it.effect('surfaces rejected values and restores the owning snapshot', () =>
    Effect.gen(function* () {
      const handler = createHarness();

      yield* withProcessServices(
        testRuntime(),
        handler.updateStateSetting(
          WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
          1000.5,
        ),
      );

      expect(mocks.writeSetting).not.toHaveBeenCalled();
      expect(mocks.showLoggedErrorMessage).toHaveBeenCalledWith(
        'SettingsViewMessageHandler',
        `Invalid value for “${WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS}”`,
        expect.any(Error),
      );
      expect(handler.postStateSettingSnapshot).toHaveBeenCalledWith('latex');
    }),
  );
});
