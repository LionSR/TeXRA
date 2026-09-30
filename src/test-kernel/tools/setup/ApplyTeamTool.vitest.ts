// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { refresh } from '@agent/index/agentRegistry';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { getDefaultTeamId } from '@shared/state/onboardingState';
import { FakeStateStore } from '@test/support/FakePlatform';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  fakeHostAgentDirectories,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { REPO_ROOT } from '@test/support/repoScan';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { ApplyTeamTool } from '@tools/setup/ApplyTeamTool';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

function workspaceRoster() {
  return testWorkspaceRoots().repoState.get(
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

async function clearOnboardingState(): Promise<void> {
  await Effect.runPromise(
    testWorkspaceRoots().repoState.update(
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
  // Real bundled agent YAMLs on disk, so the tests exercise the actual
  // name → key resolution.
  await installPlatform(
    {},
    {
      setup: createFakeSetupPlatform(),
      agentDirectories: {
        custom: () => Effect.sync(() => ''),
        customConfigured: () => Effect.succeed(false),
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
      refresh(),
      Layer.mergeAll(
        unusedGlobalStorageFs(),
        nodePlatformLayer,
        testHttpClientLayer,
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
        });

        expect(result.status).toBe('executed');
        expect(yield* workspaceRoster()).toEqual({
          kind: 'team',
          teamId: 'starter',
        });
      }),
  );

  it.effect('rejects an unknown teamId without writing any state', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'astrologer' });

      expect(result.status).toBe('error');
      yield* expectNoTeamState;
    }),
  );

  it.effect('applies a preset of bundled members', () =>
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

  it.effect('applies the physicist team with every member bundled', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'physicist' });

      expect(result.status).toBe('executed');
      expect(result.output).not.toMatch(/Not installed yet/);
      expect(result.summary).toMatch(/Applied the Physicist team/);
      expect(yield* workspaceRoster()).toEqual({
        kind: 'team',
        teamId: 'physicist',
      });
      expect(yield* getDefaultTeamId(hostStores().globalState)).toBe(
        'physicist',
      );
    }),
  );
});
