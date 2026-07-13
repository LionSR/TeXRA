import { describe, expect, it, vi } from 'vitest';

import { preflightCliTeamAvailability } from '@cli/runtime/teamAvailabilityPreflight';
import type { CliMultiAgentPresetRunPlan } from '@cli/runtime/multiAgentPresets';

function plan(missing: readonly string[]): CliMultiAgentPresetRunPlan {
  return {
    preset: {
      id: 'custom-team',
      name: 'Custom team',
      description: 'Test team',
      icon: 'tools',
      workflowAgents: [],
      toolUseAgents: ['orchestrator'],
      texraHostedAgents: ['orchestrator'],
      source: 'custom',
    },
    workflowAgentKeys: [],
    toolUseAgentKeys: [],
    missingWorkflowAgents: [],
    missingToolUseAgents: [...missing],
  };
}

function deps(input: {
  choice?: 'sign-in' | 'continue' | 'cancel';
  canAccess?: boolean;
  signedIn?: boolean;
  refreshAttempted?: boolean;
  refreshed?: CliMultiAgentPresetRunPlan;
}) {
  const refresh = vi.fn(async () => input.refreshed ?? plan([]));
  const signIn = vi.fn(async () => input.signedIn ?? true);
  return {
    refresh,
    signIn,
    value: {
      plan: plan(['orchestrator']),
      remoteCatalogRefreshAttempted: input.refreshAttempted ?? false,
      canAccessRemoteCatalog: async () => input.canAccess ?? false,
      choose: vi.fn(async () => input.choice ?? 'cancel'),
      signIn,
      refresh,
    },
  };
}

describe('CLI team availability host adapter', () => {
  it.each([
    ['cancel', 'cancelled'],
    ['continue', 'proceed'],
  ] as const)('maps the explicit %s choice to %s', async (choice, status) => {
    const subject = deps({ choice });
    await expect(
      preflightCliTeamAvailability(subject.value),
    ).resolves.toMatchObject({ status });
    expect(subject.signIn).not.toHaveBeenCalled();
    expect(subject.refresh).not.toHaveBeenCalled();
  });

  it('cancels when login does not produce catalog access', async () => {
    const subject = deps({ choice: 'sign-in', signedIn: false });
    await expect(
      preflightCliTeamAvailability(subject.value),
    ).resolves.toMatchObject({ status: 'cancelled' });
    expect(subject.signIn).toHaveBeenCalledOnce();
    expect(subject.refresh).not.toHaveBeenCalled();
  });

  it('forces exactly one fetch after successful login', async () => {
    const subject = deps({ choice: 'sign-in', signedIn: true });
    await expect(
      preflightCliTeamAvailability(subject.value),
    ).resolves.toMatchObject({ status: 'proceed' });
    expect(subject.signIn).toHaveBeenCalledOnce();
    expect(subject.refresh).toHaveBeenCalledOnce();
  });

  it('does not fetch again after the launcher already refreshed', async () => {
    const subject = deps({ canAccess: true, refreshAttempted: true });
    await expect(
      preflightCliTeamAvailability(subject.value),
    ).resolves.toMatchObject({ status: 'unavailable' });
    expect(subject.refresh).not.toHaveBeenCalled();
  });

  it('requires a choice for an arbitrary unresolved legacy member', async () => {
    const legacyPlan = plan(['remoteSpecialist']);
    const legacyPreset = { ...legacyPlan.preset };
    delete legacyPreset.texraHostedAgents;
    const choose = vi.fn(async () => 'cancel' as const);

    await expect(
      preflightCliTeamAvailability({
        plan: {
          ...legacyPlan,
          preset: legacyPreset,
          toolUseAgentKeys: ['remoteSpecialist'],
          missingToolUseAgents: ['remoteSpecialist'],
        },
        remoteCatalogRefreshAttempted: false,
        canAccessRemoteCatalog: async () => false,
        choose,
        signIn: async () => false,
        refresh: async () => legacyPlan,
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });
    expect(choose).toHaveBeenCalledWith(['remoteSpecialist']);
  });

  it('preserves full hosted provenance when refresh reveals a new missing member', async () => {
    const initial = plan(['orchestrator']);
    const preset = {
      ...initial.preset,
      toolUseAgents: ['orchestrator', 'presenter'],
      texraHostedAgents: ['orchestrator', 'presenter'],
    };
    const refreshed = {
      ...initial,
      preset,
      toolUseAgentKeys: ['remote:orchestrator', 'presenter'],
      missingToolUseAgents: ['presenter'],
    };

    await expect(
      preflightCliTeamAvailability({
        plan: { ...initial, preset },
        remoteCatalogRefreshAttempted: false,
        canAccessRemoteCatalog: async () => false,
        choose: async () => 'sign-in',
        signIn: async () => true,
        refresh: async () => refreshed,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      unavailableNames: ['presenter'],
    });
  });
});
