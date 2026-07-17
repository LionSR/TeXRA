// Standard library imports
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform } from '@platform/platform';
import { createFakePlatform } from '@test/support/FakePlatform';
import { refresh } from '@agent/index/agentRegistry';
import { getDefaultTeamId } from '@shared/state/onboardingState';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { ApplyTeamTool } from '@tools/setup/ApplyTeamTool';
import {
  __resetSetupPlatformForTests,
  setSetupPlatform,
} from '@tools/setup/platform';

import { createFakeSetupPlatform } from './fixtures';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../..',
);

// Expected workflow rosters (sorted) for the seeded teams under test.
const STARTER_WORKFLOW = ['builtInWorkflow:correct', 'builtInWorkflow:polish'];

function workspaceRoster(): {
  workflow: string[] | undefined;
  toolUse: string[] | undefined;
} {
  return {
    workflow: platform().workspaceState.get<string[]>(
      WorkspaceStateKey.ENABLED_AGENTS,
    ),
    toolUse: platform().workspaceState.get<string[]>(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
    ),
  };
}

async function clearOnboardingState(): Promise<void> {
  __resetSetupPlatformForTests();
  setSetupPlatform(createFakeSetupPlatform());
  await platform().workspaceState.update(
    WorkspaceStateKey.ENABLED_AGENTS,
    undefined,
  );
  await platform().workspaceState.update(
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
    undefined,
  );
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
  // unresolved relay-served orchestrator.
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

describe('apply_team', () => {
  beforeEach(clearOnboardingState);

  it('applies the starter roster as source-qualified workspace keys', async () => {
    const result = await new ApplyTeamTool().call({
      teamId: 'starter',
      unavailableAction: 'continue',
    });

    expect(result.status).toBe('executed');
    const roster = workspaceRoster();
    expect(roster.workflow?.toSorted()).toEqual(STARTER_WORKFLOW);
    // `orchestrator` is remote-only and unresolved while signed out: it is
    // kept as a bare name so it joins the roster on sign-in (visibility
    // filtering matches by name).
    expect(roster.toolUse?.toSorted()).toEqual([
      'builtInToolUse:assistant',
      'builtInToolUse:latexFixer',
      'builtInToolUse:research',
      'builtInToolUse:review',
      'builtInToolUse:setup',
      'orchestrator',
    ]);
  });

  it('records the user-level default team id', async () => {
    await new ApplyTeamTool().call({
      teamId: 'starter',
      unavailableAction: 'continue',
    });
    expect(getDefaultTeamId(platform().globalState)).toBe('starter');

    await new ApplyTeamTool().call({
      teamId: 'physicist',
      unavailableAction: 'continue',
    });
    expect(getDefaultTeamId(platform().globalState)).toBe('physicist');
  });

  it('reports the relay-served orchestrator as available after sign-in', async () => {
    const result = await new ApplyTeamTool().call({
      teamId: 'starter',
      unavailableAction: 'continue',
    });

    expect(result.status).toBe('executed');
    expect(result.summary).toMatch(/sign-in/);
    expect(result.output).toMatch(/orchestrator/);
    expect(result.output).toMatch(/sign-in/);
  });

  it('rejects an unknown teamId without writing any state', async () => {
    const result = await new ApplyTeamTool().call({ teamId: 'astrologer' });

    expect(result.status).toBe('error');
    const roster = workspaceRoster();
    expect(roster.workflow).toBeUndefined();
    expect(roster.toolUse).toBeUndefined();
    expect(getDefaultTeamId(platform().globalState)).toBeUndefined();
  });

  it('performs no writes before an unresolved-team choice', async () => {
    const result = await new ApplyTeamTool().call({ teamId: 'starter' });

    expect(result.status).toBe('executed');
    expect(result.output).toMatch(/Sign in to TeXRA/);
    expect(workspaceRoster()).toEqual({
      workflow: undefined,
      toolUse: undefined,
    });
    expect(getDefaultTeamId(platform().globalState)).toBeUndefined();
  });

  it('applies a preset declared local-only without prompting for sign-in', async () => {
    const result = await new ApplyTeamTool().call({
      teamId: 'software-engineer',
    });

    expect(result.status).toBe('executed');
    expect(workspaceRoster().toolUse).toEqual([
      'builtInToolUse:engineer',
      'builtInToolUse:coder',
      'builtInToolUse:codeReviewer',
      'builtInToolUse:testEngineer',
      'builtInToolUse:codeSimplifier',
    ]);
  });

  it('cancels without writing roster or default-team state', async () => {
    const result = await new ApplyTeamTool().call({
      teamId: 'starter',
      unavailableAction: 'cancel',
    });

    expect(result.status).toBe('executed');
    expect(result.output).toMatch(
      /No roster or default-team state was written/,
    );
    expect(workspaceRoster()).toEqual({
      workflow: undefined,
      toolUse: undefined,
    });
    expect(getDefaultTeamId(platform().globalState)).toBeUndefined();
  });

  it('honors an explicit continuation when catalog access is available', async () => {
    setSetupPlatform(
      createFakeSetupPlatform({
        auth: {
          getStatus: async () => ({
            authenticated: true,
            remoteAgentCatalogAvailable: true,
          }),
        },
      }),
    );

    const result = await new ApplyTeamTool().call({
      teamId: 'starter',
      unavailableAction: 'continue',
    });

    expect(result.status).toBe('executed');
    expect(result.summary).toMatch(/Applied the Starter roster/);
    expect(workspaceRoster().toolUse).toContain('orchestrator');
    expect(getDefaultTeamId(platform().globalState)).toBe('starter');
  });

  it('uses the host setup sign-in capability before its forced retry', async () => {
    const signIn = vi.fn(async () => true);
    setSetupPlatform(
      createFakeSetupPlatform({
        auth: {
          getStatus: async () => ({
            authenticated: true,
            remoteAgentCatalogAvailable: false,
          }),
          signIn,
        },
      }),
    );

    const result = await new ApplyTeamTool().call({
      teamId: 'starter',
      unavailableAction: 'sign-in',
    });

    expect(signIn).toHaveBeenCalledOnce();
    expect(result.status).toBe('error');
    expect(result).toHaveProperty(
      'error',
      expect.stringContaining('still unavailable after refreshing'),
    );
    expect(workspaceRoster()).toEqual({
      workflow: undefined,
      toolUse: undefined,
    });
  });
});
