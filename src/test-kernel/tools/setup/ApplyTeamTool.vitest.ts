// Node imports
import { resolve } from 'node:path';

// Third-party imports
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Local imports
import { refresh } from '@agent/index/agentRegistry';
import { SupabaseClient } from '@auth/SupabaseClient';
import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { AgentRosterSelection } from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { getDefaultTeamId } from '@shared/state/onboardingState';
import { createFakePlatform } from '@test/support/FakePlatform';
import { REPO_ROOT } from '@test/support/repoScan';
import {
  __resetSetupPlatformForTests,
  setSetupPlatform,
} from '@tools/setup/platform';
import { ApplyTeamTool } from '@tools/setup/ApplyTeamTool';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

function workspaceRoster(): AgentRosterSelection | undefined {
  return platform().workspaceState.get<AgentRosterSelection>(
    WorkspaceStateKey.AGENT_ROSTER_SELECTION,
  );
}

function applyTeam(
  input: Parameters<ApplyTeamTool['call']>[0],
): ReturnType<ApplyTeamTool['call']> {
  return new ApplyTeamTool().call(input);
}

function expectNoTeamState(): void {
  expect(workspaceRoster()).toBeUndefined();
  expect(getDefaultTeamId(platform().globalState)).toBeUndefined();
}

function mockSignedInCatalogAccess(canAccessCatalog: boolean): void {
  vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
  vi.spyOn(SupabaseClient, 'canAccessRemoteAgentCatalog').mockResolvedValue(
    canAccessCatalog,
  );
  vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue(null);
}

async function clearOnboardingState(): Promise<void> {
  __resetSetupPlatformForTests();
  setSetupPlatform(createFakeSetupPlatform());
  await platform().workspaceState.update(
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
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform(
      {},
      {
        fs: nodeFilesystem,
        agentDirectories: {
          custom: async () => '',
          builtIn: async () =>
            resolve(REPO_ROOT, 'packages/extension/resources/agents'),
          builtInToolUse: async () =>
            resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
        },
      },
    ),
  );
  await refresh({ includeRemote: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apply_team', () => {
  beforeEach(clearOnboardingState);

  it('applies the starter team as the canonical workspace selection', async () => {
    const result = await applyTeam({
      teamId: 'starter',
      unavailableAction: 'continue',
    });

    expect(result.status).toBe('executed');
    expect(workspaceRoster()).toEqual({ kind: 'team', teamId: 'starter' });
  });

  it('records the user-level default team id', async () => {
    await applyTeam({
      teamId: 'starter',
      unavailableAction: 'continue',
    });
    expect(getDefaultTeamId(platform().globalState)).toBe('starter');

    await applyTeam({
      teamId: 'physicist',
      unavailableAction: 'continue',
    });
    expect(getDefaultTeamId(platform().globalState)).toBe('physicist');
  });

  it('reports the account-served orchestrator as available after sign-in', async () => {
    const result = await applyTeam({
      teamId: 'starter',
      unavailableAction: 'continue',
    });

    expect(result.status).toBe('executed');
    expect(result.summary).toMatch(/sign-in/);
    expect(result.output).toMatch(/orchestrator/);
    expect(result.output).toMatch(/sign-in/);
  });

  it('rejects an unknown teamId without writing any state', async () => {
    const result = await applyTeam({ teamId: 'astrologer' });

    expect(result.status).toBe('error');
    expectNoTeamState();
  });

  it('performs no writes before an unresolved-team choice', async () => {
    const result = await applyTeam({ teamId: 'starter' });

    expect(result.status).toBe('executed');
    expect(result.output).toMatch(/Sign in to TeXRA/);
    expectNoTeamState();
  });

  it('applies a preset declared local-only without prompting for sign-in', async () => {
    const result = await applyTeam({
      teamId: 'software-engineer',
    });

    expect(result.status).toBe('executed');
    expect(workspaceRoster()).toEqual({
      kind: 'team',
      teamId: 'software-engineer',
    });
  });

  it('cancels without writing roster or default-team state', async () => {
    const result = await applyTeam({
      teamId: 'starter',
      unavailableAction: 'cancel',
    });

    expect(result.status).toBe('executed');
    expect(result.output).toMatch(
      /No roster or default-team state was written/,
    );
    expectNoTeamState();
  });

  it('honors an explicit continuation when catalog access is available', async () => {
    mockSignedInCatalogAccess(true);

    const result = await applyTeam({
      teamId: 'starter',
      unavailableAction: 'continue',
    });

    expect(result.status).toBe('executed');
    expect(result.summary).toMatch(/Applied the Starter roster/);
    expect(workspaceRoster()).toEqual({ kind: 'team', teamId: 'starter' });
    expect(getDefaultTeamId(platform().globalState)).toBe('starter');
  });

  it('uses the host setup sign-in capability before its forced retry', async () => {
    const signIn = vi.fn(async () => true);
    mockSignedInCatalogAccess(false);
    setSetupPlatform(createFakeSetupPlatform({ signIn }));

    const result = await applyTeam({
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
  });
});
