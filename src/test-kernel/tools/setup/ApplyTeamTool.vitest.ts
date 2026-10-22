// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { AgentCatalog } from '@agent/index/agentCatalog';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { REPO_ROOT } from '@test/support/repoScan';
import { ApplyTeamTool } from '@texra/tools/setup/ApplyTeamTool';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

const defaultTeamId = () =>
  hostStores().globalState.get(GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID);

function workspaceAgents() {
  return testWorkspaceRoots().repoState.get(WorkspaceStateKey.WORKSPACE_AGENTS);
}

function applyTeam(input: Parameters<(typeof ApplyTeamTool)['call']>[0]) {
  return ApplyTeamTool.call(input).pipe(Effect.provide(nativeToolTestLayer()));
}

const expectNoTeamState = Effect.gen(function* () {
  expect(yield* workspaceAgents()).toBeUndefined();
  expect(yield* defaultTeamId()).toBeUndefined();
});

async function clearOnboardingState(): Promise<void> {
  await Effect.runPromise(
    testWorkspaceRoots().repoState.update(
      WorkspaceStateKey.WORKSPACE_AGENTS,
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
      },
    },
  );
  await testRuntime().runPromise(
    AgentCatalog.use((catalog) => catalog.refresh),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apply_team', () => {
  beforeEach(clearOnboardingState);

  it.effect('rejects an unknown teamId without writing any state', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'astrologer' });

      expect(result.status).toBe('error');
      yield* expectNoTeamState;
    }),
  );

  it.effect('applies the physicist team with every member bundled', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'physicist' });

      expect(result.status).toBe('executed');
      expect(result.output).not.toMatch(/Not installed yet/);
      expect(result.summary).toMatch(/Applied the Physicist team/);
      expect(yield* workspaceAgents()).toEqual({
        kind: 'team',
        teamId: 'physicist',
      });
      expect(yield* defaultTeamId()).toBe('physicist');
    }),
  );
});
