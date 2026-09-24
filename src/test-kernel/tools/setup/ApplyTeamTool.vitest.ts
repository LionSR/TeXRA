// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { refresh } from '@agent/index/agentRegistry';
import { AgentDirectories, AppState } from '@platform/interfaces';
import type { AgentRosterSelection } from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { getDefaultTeamId } from '@shared/state/onboardingState';
import { FakeStateStore } from '@test/support/FakePlatform';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { fakeSupabaseAuth } from '@test/support/fakeSupabaseAuth';
import {
  fakeHostAgentDirectories,
  hostStores,
  installHostAuth,
  installPlatform,
} from '@test/support/setupPlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { REPO_ROOT } from '@test/support/repoScan';
import { ApplyTeamTool } from '@tools/setup/ApplyTeamTool';
import type { SetupPlatformShape } from '@tools/setup/platform';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

function workspaceRoster() {
  return testWorkspaceRoots().workspaceState.get<AgentRosterSelection>(
    WorkspaceStateKey.AGENT_ROSTER_SELECTION,
  );
}

function applyTeam(input: Parameters<(typeof ApplyTeamTool)['call']>[0]) {
  return ApplyTeamTool.call(input).pipe(Effect.provide(nativeToolTestLayer()));
}

const expectNoTeamState = Effect.gen(function* () {
  expect(yield* workspaceRoster()).toBeUndefined();
  expect(yield* getDefaultTeamId(hostStores().globalState)).toBeUndefined();
});

/**
 * The installed fake host's setup sign-in: a suite-level double the host is
 * built with once, so a test steers sign-in without swapping hosts.
 */
const signIn = vi.fn<SetupPlatformShape['signIn']>();

function mockCatalogAccess(canAccessCatalog: boolean): void {
  installHostAuth(
    fakeSupabaseAuth({ authenticated: Effect.succeed(canAccessCatalog) }),
  );
}

async function clearOnboardingState(): Promise<void> {
  signIn.mockReset();
  signIn.mockReturnValue(Effect.succeed(false));
  await Effect.runPromise(
    testWorkspaceRoots().workspaceState.update(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      undefined,
    ),
  );
  await Effect.runPromise(
    hostStores().globalState.update(
      GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID,
      undefined,
    ),
  );
}

beforeAll(async () => {
  // Real bundled agent YAMLs on disk and no remote agents (signed out), so
  // the tests exercise the actual name → key resolution including the
  // unresolved TeXRA-hosted workflow members of the Physicist team.
  await installPlatform(
    {},
    {
      setup: createFakeSetupPlatform({ signIn }),
      agentDirectories: {
        custom: () => Effect.sync(() => ''),
        builtIn: () =>
          Effect.sync(() =>
            resolve(REPO_ROOT, 'packages/extension/resources/agents'),
          ),
        builtInToolUse: () =>
          Effect.sync(() =>
            resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
          ),
      },
    },
  );
  await Effect.runPromise(
    Effect.provide(
      refresh({ includeRemote: false }),
      Layer.mergeAll(
        unusedGlobalStorageFs(),
        nodePlatformLayer,
        AgentDirectories.layer(fakeHostAgentDirectories),
        AppState.layer(new FakeStateStore()),
      ),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apply_team', () => {
  beforeEach(clearOnboardingState);

  it.effect(
    'applies the starter team as the canonical workspace selection',
    () =>
      Effect.gen(function* () {
        const result = yield* applyTeam({
          teamId: 'starter',
          unavailableAction: 'continue',
        });

        expect(result.status).toBe('executed');
        expect(yield* workspaceRoster()).toEqual({
          kind: 'team',
          teamId: 'starter',
        });
      }),
  );

  it.effect('records the user-level default team id', () =>
    Effect.gen(function* () {
      yield* applyTeam({
        teamId: 'starter',
        unavailableAction: 'continue',
      });
      expect(yield* getDefaultTeamId(hostStores().globalState)).toBe('starter');

      yield* applyTeam({
        teamId: 'physicist',
        unavailableAction: 'continue',
      });
      expect(yield* getDefaultTeamId(hostStores().globalState)).toBe(
        'physicist',
      );
    }),
  );

  it.effect('rejects an unknown teamId without writing any state', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'astrologer' });

      expect(result.status).toBe('error');
      yield* expectNoTeamState;
    }),
  );

  it.effect('performs no writes before an unresolved-team choice', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'physicist' });

      expect(result.status).toBe('executed');
      expect(result.output).toMatch(/Sign in to TeXRA/);
      yield* expectNoTeamState;
    }),
  );

  it.effect(
    'applies a preset declared local-only without prompting for sign-in',
    () =>
      Effect.gen(function* () {
        const result = yield* applyTeam({
          teamId: 'software-engineer',
        });

        expect(result.status).toBe('executed');
        expect(yield* workspaceRoster()).toEqual({
          kind: 'team',
          teamId: 'software-engineer',
        });
      }),
  );

  it.effect('cancels without writing roster or default-team state', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({
        teamId: 'physicist',
        unavailableAction: 'cancel',
      });

      expect(result.status).toBe('executed');
      expect(result.output).toMatch(
        /No roster or default-team state was written/,
      );
      yield* expectNoTeamState;
    }),
  );

  it.effect(
    'honors an explicit continuation when catalog access is available',
    () =>
      Effect.gen(function* () {
        mockCatalogAccess(true);

        const result = yield* applyTeam({
          teamId: 'physicist',
          unavailableAction: 'continue',
        });

        expect(result.status).toBe('executed');
        expect(result.summary).toMatch(/Applied the Physicist roster/);
        expect(yield* workspaceRoster()).toEqual({
          kind: 'team',
          teamId: 'physicist',
        });
        expect(yield* getDefaultTeamId(hostStores().globalState)).toBe(
          'physicist',
        );
      }),
  );

  it.effect(
    'uses the host setup sign-in capability before its forced retry',
    () =>
      Effect.gen(function* () {
        signIn.mockReturnValue(Effect.succeed(true));
        mockCatalogAccess(false);

        const result = yield* applyTeam({
          teamId: 'physicist',
          unavailableAction: 'sign-in',
        });

        expect(signIn).toHaveBeenCalledOnce();
        expect(result.status).toBe('error');
        expect(result).toHaveProperty(
          'error',
          expect.stringContaining('still unavailable after refreshing'),
        );
        expect(yield* workspaceRoster()).toBeUndefined();
      }),
  );
});
