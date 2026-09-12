// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { refresh } from '@agent/index/agentRegistry';
import { SupabaseClient } from '@auth/SupabaseClient';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { AgentRosterSelection } from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { getDefaultTeamId } from '@shared/state/onboardingState';
import { installPlatform } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { REPO_ROOT } from '@test/support/repoScan';
import { ApplyTeamTool } from '@tools/setup/ApplyTeamTool';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

function workspaceRoster(): AgentRosterSelection | undefined {
  return workspaceRoots().workspaceState.get<AgentRosterSelection>(
    WorkspaceStateKey.AGENT_ROSTER_SELECTION,
  );
}

function applyTeam(input: Parameters<ApplyTeamTool['call']>[0]) {
  return new ApplyTeamTool()
    .call(input)
    .pipe(Effect.provide(nativeToolTestLayer()));
}

function expectNoTeamState(): void {
  expect(workspaceRoster()).toBeUndefined();
  expect(getDefaultTeamId(platform().globalState)).toBeUndefined();
}

/**
 * The installed fake host's setup sign-in: a suite-level double the host is
 * built with once, so a test steers sign-in without swapping hosts.
 */
const signIn = vi.fn<() => Promise<boolean>>();

function mockCatalogAccess(canAccessCatalog: boolean): void {
  vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(
    canAccessCatalog,
  );
  vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue(null);
}

async function clearOnboardingState(): Promise<void> {
  signIn.mockReset();
  signIn.mockResolvedValue(false);
  await workspaceRoots().workspaceState.update(
    WorkspaceStateKey.AGENT_ROSTER_SELECTION,
    undefined,
  );
  await platform().globalState.update(
    GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID,
    undefined,
  );
}

beforeAll(async () => {
  // Real bundled agent YAMLs on disk and no remote agents (signed out), so
  // the tests exercise the actual name → key resolution including the
  // unresolved account-served orchestrator.
  await installPlatform(
    {},
    {
      fs: nodeFilesystem,
      setup: createFakeSetupPlatform({ signIn }),
      agentDirectories: {
        custom: async () => '',
        builtIn: async () =>
          resolve(REPO_ROOT, 'packages/extension/resources/agents'),
        builtInToolUse: async () =>
          resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
      },
    },
  );
  await Effect.runPromise(refresh({ includeRemote: false }));
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
        expect(workspaceRoster()).toEqual({ kind: 'team', teamId: 'starter' });
      }),
  );

  it.effect('records the user-level default team id', () =>
    Effect.gen(function* () {
      yield* applyTeam({
        teamId: 'starter',
        unavailableAction: 'continue',
      });
      expect(getDefaultTeamId(platform().globalState)).toBe('starter');

      yield* applyTeam({
        teamId: 'physicist',
        unavailableAction: 'continue',
      });
      expect(getDefaultTeamId(platform().globalState)).toBe('physicist');
    }),
  );

  it.effect('rejects an unknown teamId without writing any state', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'astrologer' });

      expect(result.status).toBe('error');
      expectNoTeamState();
    }),
  );

  it.effect('performs no writes before an unresolved-team choice', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({ teamId: 'starter' });

      expect(result.status).toBe('executed');
      expect(result.output).toMatch(/Sign in to TeXRA/);
      expectNoTeamState();
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
        expect(workspaceRoster()).toEqual({
          kind: 'team',
          teamId: 'software-engineer',
        });
      }),
  );

  it.effect('cancels without writing roster or default-team state', () =>
    Effect.gen(function* () {
      const result = yield* applyTeam({
        teamId: 'starter',
        unavailableAction: 'cancel',
      });

      expect(result.status).toBe('executed');
      expect(result.output).toMatch(
        /No roster or default-team state was written/,
      );
      expectNoTeamState();
    }),
  );

  it.effect(
    'honors an explicit continuation when catalog access is available',
    () =>
      Effect.gen(function* () {
        mockCatalogAccess(true);

        const result = yield* applyTeam({
          teamId: 'starter',
          unavailableAction: 'continue',
        });

        expect(result.status).toBe('executed');
        expect(result.summary).toMatch(/Applied the Starter roster/);
        expect(workspaceRoster()).toEqual({ kind: 'team', teamId: 'starter' });
        expect(getDefaultTeamId(platform().globalState)).toBe('starter');
      }),
  );

  it.effect(
    'uses the host setup sign-in capability before its forced retry',
    () =>
      Effect.gen(function* () {
        signIn.mockResolvedValue(true);
        mockCatalogAccess(false);

        const result = yield* applyTeam({
          teamId: 'starter',
          unavailableAction: 'sign-in',
        });

        expect(signIn).toHaveBeenCalledOnce();
        expect(result.status).toBe('error');
        expect(result).toHaveProperty(
          'error',
          expect.stringContaining('still unavailable after refreshing'),
        );
        expect(workspaceRoster()).toBeUndefined();
      }),
  );
});
