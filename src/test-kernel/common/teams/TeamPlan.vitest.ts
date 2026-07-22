import { describe, expect, it, vi } from 'vitest';

import {
  buildTeamOptions,
  canLaunchTeam,
  findTeamPreset,
  loadTeamOptions,
  planTeamRun,
  refreshRemoteCatalogForGaps,
  resolveTeamLaunch,
  teamAvailability,
  teamExecutionFields,
  teamLaunchBlockReason,
  teamPlanHasGaps,
  teamPlanStatus,
  teamPresets,
  teamTexraHostedMissingNames,
  type TeamCatalogAgent,
  type TeamPreset,
  type TeamRunPlan,
} from '@common/teams/TeamPlan';
import {
  AGENT_MODE_PRESETS,
  STARTER_AGENT_MODE_PRESET,
} from '@shared/schemas/agentPresets';

const delegateTools = ['delegate_agent'];

function agent(
  name: string,
  options: Partial<TeamCatalogAgent> = {},
): TeamCatalogAgent {
  return {
    name,
    source: 'builtInToolUse',
    ...options,
  };
}

function preset(overrides: Partial<TeamPreset> = {}): TeamPreset {
  return {
    id: 'custom-team',
    name: 'Custom Team',
    description: 'A custom team.',
    icon: 'bookmark',
    workflowAgents: ['writer'],
    toolUseAgents: ['lead', 'member'],
    source: 'custom',
    ...overrides,
  };
}

function manualPlan(overrides: Partial<TeamRunPlan> = {}): TeamRunPlan {
  return {
    preset: preset(),
    rootAgent: agent('lead', { tools: delegateTools }),
    workflowAgentKeys: ['builtInWorkflow:writer'],
    toolUseAgentKeys: ['builtInToolUse:lead', 'builtInToolUse:member'],
    missingWorkflowAgents: [],
    missingToolUseAgents: [],
    ...overrides,
  };
}

describe('teamPresets', () => {
  it('tags built-ins and customs while preserving provenance and order', () => {
    const custom = preset({ id: 'zeta', name: 'Zeta' });
    const presets = teamPresets([custom]);

    expect(
      presets.slice(0, AGENT_MODE_PRESETS.length).map((item) => item.id),
    ).toEqual(AGENT_MODE_PRESETS.map((item) => item.id));
    expect(
      presets
        .slice(0, AGENT_MODE_PRESETS.length)
        .every((item) => item.source === 'built-in'),
    ).toBe(true);
    expect(presets.at(-1)).toMatchObject({ id: 'zeta', source: 'custom' });
  });

  it('excludes the starter preset and drops custom built-in id collisions', () => {
    const collision = preset({
      id: AGENT_MODE_PRESETS[0].id,
      name: 'Shadow Built-in',
    });
    const presets = teamPresets([STARTER_AGENT_MODE_PRESET, collision]);

    expect(presets).toHaveLength(AGENT_MODE_PRESETS.length);
    expect(
      presets.some((item) => item.id === STARTER_AGENT_MODE_PRESET.id),
    ).toBe(false);
    expect(presets.find((item) => item.id === collision.id)?.source).toBe(
      'built-in',
    );
  });
});

describe('findTeamPreset', () => {
  it('matches case-insensitive ids, names, and name slugs', () => {
    const target = preset({ id: 'my-id', name: 'My Research Team' });
    const presets = [target];

    expect(findTeamPreset(presets, ' MY-ID ')).toBe(target);
    expect(findTeamPreset(presets, 'my research team')).toBe(target);
    expect(findTeamPreset(presets, 'MY-RESEARCH-TEAM')).toBe(target);
    expect(findTeamPreset(presets, 'missing')).toBeUndefined();
  });
});

describe('planTeamRun', () => {
  it('selects the orchestrator for the built-in physicist team', () => {
    const physicist = teamPresets([]).find((item) => item.id === 'physicist')!;
    const plan = planTeamRun(physicist, {
      workflowAgents: [],
      toolUseAgents: [
        agent('research', { tools: delegateTools }),
        agent('orchestrator', { source: 'remote', tools: delegateTools }),
      ],
    });

    expect(plan.rootAgent?.name).toBe('orchestrator');
  });

  it('selects engineer for the built-in software-engineer team', () => {
    const software = teamPresets([]).find(
      (item) => item.id === 'software-engineer',
    )!;
    const plan = planTeamRun(software, {
      workflowAgents: [],
      toolUseAgents: [
        agent('coder', { tools: delegateTools }),
        agent('engineer', { tools: delegateTools }),
      ],
    });

    expect(plan.rootAgent?.name).toBe('engineer');
  });

  it('does not fall back to an arbitrary delegating agent for a built-in', () => {
    const physicist = teamPresets([]).find((item) => item.id === 'physicist')!;
    const plan = planTeamRun(physicist, {
      workflowAgents: [],
      toolUseAgents: [agent('research', { tools: delegateTools })],
    });

    expect(plan.rootAgent).toBeUndefined();
  });

  it('selects the first delegation-capable custom member in preset order', () => {
    const plan = planTeamRun(
      preset({ toolUseAgents: ['second', 'first', 'plain'] }),
      {
        workflowAgents: [],
        toolUseAgents: [
          agent('first', { tools: delegateTools }),
          agent('second', { tools: delegateTools }),
          agent('plain'),
        ],
      },
    );

    expect(plan.rootAgent?.name).toBe('second');
  });

  it('honors name-or-key overrides and reports a missing override', () => {
    const customLead = agent('lead', {
      source: 'custom',
      tools: delegateTools,
    });
    const options = {
      workflowAgents: [],
      toolUseAgents: [customLead, agent('member')],
    };

    const selected = planTeamRun(preset(), {
      ...options,
      agentOverride: 'custom:lead',
    });
    const missing = planTeamRun(preset(), {
      ...options,
      agentOverride: 'remote:lead',
    });

    expect(selected.rootAgent).toBe(customLead);
    expect(selected.missingAgentOverride).toBeUndefined();
    expect(missing.rootAgent).toBe(customLead);
    expect(missing.missingAgentOverride).toBe('remote:lead');
  });

  it('appends an override root once and deduplicates by canonical key', () => {
    const lead = agent('lead', { tools: delegateTools });
    const external = agent('external', {
      source: 'custom',
      tools: delegateTools,
    });
    const included = planTeamRun(preset(), {
      workflowAgents: [],
      toolUseAgents: [lead, agent('member')],
      agentOverride: 'lead',
    });
    const appended = planTeamRun(preset(), {
      workflowAgents: [],
      toolUseAgents: [lead, agent('member'), external],
      agentOverride: 'custom:external',
    });

    expect(included.toolUseAgentKeys).toEqual([
      'builtInToolUse:lead',
      'builtInToolUse:member',
    ]);
    expect(appended.toolUseAgentKeys).toEqual([
      'builtInToolUse:lead',
      'builtInToolUse:member',
      'custom:external',
    ]);
  });
});

describe('plan status and launchability', () => {
  it('detects gaps and filters missing names to TeXRA-hosted members', () => {
    const plan = manualPlan({
      preset: preset({
        texraHostedAgents: ['hosted-workflow', 'hosted-tool'],
      }),
      missingWorkflowAgents: ['hosted-workflow', 'local-workflow'],
      missingToolUseAgents: ['hosted-tool', 'local-tool'],
    });

    expect(teamPlanHasGaps(plan)).toBe(true);
    expect(teamTexraHostedMissingNames(plan)).toEqual([
      'hosted-workflow',
      'hosted-tool',
    ]);
  });

  it('returns all three launch-block reasons', () => {
    const noRoot = manualPlan({ rootAgent: undefined });
    const nonDelegating = manualPlan({ rootAgent: agent('plain') });
    const noMembers = manualPlan({
      preset: preset({ workflowAgents: [], toolUseAgents: ['lead'] }),
      workflowAgentKeys: [],
      toolUseAgentKeys: ['builtInToolUse:lead'],
    });

    expect(teamLaunchBlockReason(noRoot)).toBe('no runnable team root');
    expect(teamLaunchBlockReason(nonDelegating)).toBe(
      'team root plain is not a delegating agent',
    );
    expect(teamLaunchBlockReason(noMembers)).toBe('no available team members');
  });

  it('narrows launchable plans and classifies availability status', () => {
    const available = manualPlan();
    const degraded = manualPlan({ missingWorkflowAgents: ['missing'] });
    const unavailable = manualPlan({ rootAgent: undefined });

    expect(canLaunchTeam(available)).toBe(true);
    expect(canLaunchTeam(unavailable)).toBe(false);
    expect(teamPlanStatus(available)).toBe('available');
    expect(teamPlanStatus(degraded)).toBe('degraded');
    expect(teamPlanStatus(unavailable)).toBe('unavailable');
  });

  it('reports per-category counts, labels, root identity, and override gaps', () => {
    const plan = manualPlan({
      missingAgentOverride: 'missing-lead',
      missingWorkflowAgents: ['writer'],
      missingToolUseAgents: ['member'],
    });

    expect(teamAvailability(plan)).toEqual({
      status: 'degraded',
      workflow: {
        available: 0,
        total: 1,
        missing: ['writer'],
        label: '0/1',
      },
      toolUse: {
        available: 1,
        total: 2,
        missing: ['member'],
        label: '1/2',
      },
      rootAgent: {
        key: 'builtInToolUse:lead',
        name: 'lead',
        source: 'builtInToolUse',
      },
      missingAgentOverride: 'missing-lead',
    });
    expect(teamAvailability(manualPlan()).workflow.label).toBe('1');
  });
});

describe('teamExecutionFields', () => {
  it('builds execution fields from a launchable plan', () => {
    const plan = manualPlan();
    if (!canLaunchTeam(plan)) throw new Error('Expected a launchable plan');

    expect(teamExecutionFields(plan)).toEqual({
      agent: 'builtInToolUse:lead',
      delegationAgentScope: {
        workflowAgentKeys: ['builtInWorkflow:writer'],
        toolUseAgentKeys: ['builtInToolUse:lead', 'builtInToolUse:member'],
      },
      cliMultiAgentPresetId: 'custom-team',
    });
  });
});

describe('buildTeamOptions', () => {
  it('keeps built-in declaration order, alphabetizes customs, and maps state', () => {
    const builtInA = manualPlan({
      preset: preset({
        id: 'physicist',
        name: 'Physicist',
        source: 'built-in',
      }),
    });
    const builtInB = manualPlan({
      preset: preset({
        id: 'lean-project',
        name: 'Lean Project',
        source: 'built-in',
      }),
    });
    const customZ = manualPlan({
      preset: preset({ id: 'cz', name: 'Zulu' }),
      missingWorkflowAgents: ['writer'],
      missingToolUseAgents: ['member'],
    });
    const customA = manualPlan({
      preset: preset({ id: 'ca', name: 'Alpha' }),
      rootAgent: undefined,
    });

    const options = buildTeamOptions([customZ, builtInA, customA, builtInB]);

    expect(options.map((option) => option.value)).toEqual([
      'lean-project',
      'physicist',
      'ca',
      'cz',
    ]);
    expect(options[2]).toMatchObject({
      source: 'custom',
      icon: 'bookmark',
      description: 'A custom team.',
      rootAgentName: null,
      disabled: true,
      disabledReason: 'No runnable team lead.',
    });
    expect(options[3].unavailableMembers).toEqual(['writer', 'member']);
    expect(options[3].disabled).toBeUndefined();
  });

  it('capitalizes non-root disabled reasons', () => {
    const option = buildTeamOptions([
      manualPlan({ rootAgent: agent('plain') }),
    ])[0];
    expect(option.disabledReason).toBe(
      'Team root plain is not a delegating agent.',
    );
  });
});

describe('loadTeamOptions', () => {
  it('refreshes a gapped plan when remote access exists and builds final options', async () => {
    let refreshed = false;
    const ensureCatalogLoaded = vi.fn(async () => undefined);
    const refreshRemote = vi.fn(async () => {
      refreshed = true;
    });
    const custom = preset();

    const options = await loadTeamOptions({
      customPresetsRaw: [custom],
      ensureCatalogLoaded,
      getAgents: (category) => {
        if (!refreshed) return [];
        return category === 'workflow'
          ? [agent('writer', { source: 'builtInWorkflow' })]
          : [agent('lead', { tools: delegateTools }), agent('member')];
      },
      canAccessRemoteCatalog: async () => true,
      refreshRemote,
    });

    expect(ensureCatalogLoaded).toHaveBeenCalledOnce();
    expect(refreshRemote).toHaveBeenCalledOnce();
    expect(options.find((option) => option.value === custom.id)).toMatchObject({
      disabled: undefined,
      rootAgentName: 'lead',
      unavailableMembers: [],
    });
  });

  it('does not refresh gapped plans without remote catalog access', async () => {
    const refreshRemote = vi.fn(async () => undefined);

    await loadTeamOptions({
      customPresetsRaw: [preset()],
      ensureCatalogLoaded: async () => undefined,
      getAgents: () => [],
      canAccessRemoteCatalog: async () => false,
      refreshRemote,
    });

    expect(refreshRemote).not.toHaveBeenCalled();
  });

  it('loads the catalog before planning team options', async () => {
    let loaded = false;
    const getAgents = vi.fn(() => {
      expect(loaded).toBe(true);
      return [];
    });

    await loadTeamOptions({
      customPresetsRaw: [],
      ensureCatalogLoaded: async () => {
        loaded = true;
      },
      getAgents,
      canAccessRemoteCatalog: async () => false,
      refreshRemote: async () => undefined,
    });

    expect(getAgents).toHaveBeenCalled();
  });
});

describe('resolveTeamLaunch', () => {
  type LaunchArgs = Parameters<typeof resolveTeamLaunch<TeamCatalogAgent>>[0];

  function launchArgs(overrides: Partial<LaunchArgs> = {}): LaunchArgs {
    const workflowAgents = [agent('writer', { source: 'builtInWorkflow' })];
    const toolUseAgents = [
      agent('lead', { tools: delegateTools }),
      agent('member'),
    ];
    return {
      teamId: 'custom-team',
      customPresetsRaw: [preset()],
      ensureCatalogLoaded: async () => undefined,
      getAgents: (category: string) =>
        category === 'workflow' ? workflowAgents : toolUseAgents,
      canAccessRemoteCatalog: async () => false,
      refreshRemote: async () => undefined,
      choose: async () => 'cancel' as const,
      signIn: async () => false,
      ...overrides,
    };
  }

  /** A custom team whose single workflow member is missing and TeXRA-hosted. */
  function hostedWriterPreset(): TeamPreset {
    return preset({
      workflowAgents: ['hosted-writer'],
      texraHostedAgents: ['hosted-writer'],
    });
  }

  it('returns execution-scoped fields for a ready team', async () => {
    await expect(resolveTeamLaunch(launchArgs())).resolves.toEqual({
      status: 'ready',
      fields: {
        agent: 'builtInToolUse:lead',
        delegationAgentScope: {
          workflowAgentKeys: ['builtInWorkflow:writer'],
          toolUseAgentKeys: ['builtInToolUse:lead', 'builtInToolUse:member'],
        },
        cliMultiAgentPresetId: 'custom-team',
      },
      partial: false,
      missingNames: [],
    });
  });

  it('loads the catalog before planning a team launch', async () => {
    let loaded = false;
    const getAgents = vi.fn((category: string) => {
      expect(loaded).toBe(true);
      return category === 'workflow'
        ? [agent('writer', { source: 'builtInWorkflow' })]
        : [agent('lead', { tools: delegateTools }), agent('member')];
    });

    await expect(
      resolveTeamLaunch(
        launchArgs({
          ensureCatalogLoaded: async () => {
            loaded = true;
          },
          getAgents,
        }),
      ),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(getAgents).toHaveBeenCalled();
  });

  it('continues with available members and reports a partial team', async () => {
    const hostedPreset = preset({
      workflowAgents: ['writer', 'hosted-writer'],
      texraHostedAgents: ['hosted-writer'],
    });

    await expect(
      resolveTeamLaunch(
        launchArgs({
          customPresetsRaw: [hostedPreset],
          choose: async () => 'continue' as const,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      partial: true,
      missingNames: ['hosted-writer'],
    });
  });

  it('uses a provided continue choice without invoking the interactive port', async () => {
    const choose = vi.fn(async () => undefined);
    await expect(
      resolveTeamLaunch(
        launchArgs({
          customPresetsRaw: [hostedWriterPreset()],
          providedChoice: 'continue',
          choose,
        }),
      ),
    ).resolves.toMatchObject({ status: 'ready', partial: true });
    expect(choose).not.toHaveBeenCalled();
  });

  it('treats an explicit cancel or dismissed choice as cancelled', async () => {
    await expect(
      resolveTeamLaunch(
        launchArgs({
          customPresetsRaw: [hostedWriterPreset()],
        }),
      ),
    ).resolves.toEqual({ status: 'cancelled' });
    await expect(
      resolveTeamLaunch(
        launchArgs({
          customPresetsRaw: [hostedWriterPreset()],
          choose: async () => undefined,
        }),
      ),
    ).resolves.toEqual({ status: 'cancelled' });
  });

  it('reports hosted members still unavailable after remote refresh', async () => {
    const refreshRemote = vi.fn(async () => undefined);
    await expect(
      resolveTeamLaunch(
        launchArgs({
          customPresetsRaw: [hostedWriterPreset()],
          canAccessRemoteCatalog: async () => true,
          refreshRemote,
        }),
      ),
    ).resolves.toEqual({
      status: 'unavailable',
      unavailableNames: ['hosted-writer'],
    });
    expect(refreshRemote).toHaveBeenCalledOnce();
  });

  it('reports an unknown team without consulting catalog ports', async () => {
    const getAgents = vi.fn(() => []);
    await expect(
      resolveTeamLaunch(launchArgs({ teamId: 'missing', getAgents })),
    ).resolves.toEqual({ status: 'unknown-team' });
    expect(getAgents).not.toHaveBeenCalled();
  });

  it('blocks a planned team with no delegation-capable root', async () => {
    await expect(
      resolveTeamLaunch(
        launchArgs({
          customPresetsRaw: [preset({ toolUseAgents: ['plain'] })],
          getAgents: (category: string) =>
            category === 'workflow'
              ? [agent('writer', { source: 'builtInWorkflow' })]
              : [agent('plain')],
        }),
      ),
    ).resolves.toEqual({
      status: 'blocked',
      reason: 'no runnable team root',
    });
  });
});

describe('refreshRemoteCatalogForGaps', () => {
  it('refreshes and returns the replanned value only when gaps and access exist', async () => {
    const refreshRemote = vi.fn(async () => undefined);
    const replan = vi.fn(() => 'remote');
    const canAccessRemoteCatalog = vi.fn(async () => true);

    const result = await refreshRemoteCatalogForGaps(
      'local',
      () => true,
      replan,
      { canAccessRemoteCatalog, refreshRemote },
    );

    expect(result).toEqual({
      value: 'remote',
      remoteCatalogRefreshAttempted: true,
    });
    expect(refreshRemote).toHaveBeenCalledOnce();
    expect(replan).toHaveBeenCalledOnce();
  });

  it('skips access, refresh, and replan without gaps', async () => {
    const canAccessRemoteCatalog = vi.fn(async () => true);
    const refreshRemote = vi.fn(async () => undefined);
    const replan = vi.fn(() => 'remote');

    const result = await refreshRemoteCatalogForGaps(
      'local',
      () => false,
      replan,
      { canAccessRemoteCatalog, refreshRemote },
    );

    expect(result).toEqual({
      value: 'local',
      remoteCatalogRefreshAttempted: false,
    });
    expect(canAccessRemoteCatalog).not.toHaveBeenCalled();
    expect(refreshRemote).not.toHaveBeenCalled();
    expect(replan).not.toHaveBeenCalled();
  });

  it('does not refresh or replan when remote access is unavailable', async () => {
    const refreshRemote = vi.fn(async () => undefined);
    const replan = vi.fn(() => 'remote');

    const result = await refreshRemoteCatalogForGaps(
      'local',
      () => true,
      replan,
      {
        canAccessRemoteCatalog: async () => false,
        refreshRemote,
      },
    );

    expect(result).toEqual({
      value: 'local',
      remoteCatalogRefreshAttempted: false,
    });
    expect(refreshRemote).not.toHaveBeenCalled();
    expect(replan).not.toHaveBeenCalled();
  });
});
