// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  cliMultiAgentPresetListRecord,
  cliMultiAgentPresetNdjsonRecords,
  formatCliMultiAgentPresetLauncherHints,
  formatCliMultiAgentPresetLauncherSummary,
  formatCliMultiAgentTeamLaunchBlockMessage,
  formatCliMultiAgentPresetInspection,
  formatCliMultiAgentPresetList,
  formatCliMultiAgentPresetRunWarnings,
  type CliMultiAgentPresetRunPlan,
} from '@cli/runtime/multiAgentPresets';
import {
  canLaunchTeam,
  findTeamPreset,
  planTeamRun,
  planTeamRuns,
  teamAvailability,
  teamLaunchBlockReason,
  teamPlanHasGaps,
  teamPresets,
} from '@common/teams/TeamPlan';

function agent(
  name: string,
  category: AgentCategory,
  tools: string[] = [],
): AgentEntry {
  return {
    name,
    category,
    source:
      category === AgentCategory.ToolUse ? 'builtInToolUse' : 'builtInWorkflow',
    path: `/agents/${name}.yaml`,
    tools,
  };
}

function findPreset(id: string) {
  return findTeamPreset(teamPresets(undefined), id)!;
}

// `AgentEntry`-pinned so the derived parameter/return types below match
// `CliMultiAgentPresetRunPlan` instead of the unpinned `TeamCatalogAgent` bound.
const planTeamRunForAgentEntry = planTeamRun<AgentEntry>;
type TeamPreset = Parameters<typeof planTeamRunForAgentEntry>[0];
type TeamRunOptions = Parameters<typeof planTeamRunForAgentEntry>[1];

function planRun(
  preset: TeamPreset,
  options: Partial<TeamRunOptions['agents']> & {
    agentOverride?: string;
  } = {},
) {
  const { agentOverride, ...agents } = options;
  return planTeamRunForAgentEntry(preset, {
    agents: { workflow: [], toolUse: [], ...agents },
    agentOverride,
  });
}

// The full tool-use roster of a preset, with only `root` able to delegate.
function toolUseTeam(preset: TeamPreset, root: string): AgentEntry[] {
  return preset.agents.toolUse.map((name) =>
    agent(name, AgentCategory.ToolUse, name === root ? ['delegate_agent'] : []),
  );
}

// The lean-project team with two of its seven members and no delegating root.
function partialLeanProjectPlan(): CliMultiAgentPresetRunPlan {
  return planRun(findPreset('lean-project'), {
    toolUse: [
      agent('lean', AgentCategory.ToolUse),
      agent('latexFixer', AgentCategory.ToolUse),
    ],
  });
}

// The physicist team reduced to its delegating root plus one member.
function degradedPhysicistToolUse(): AgentEntry[] {
  return [
    agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
    agent('review', AgentCategory.ToolUse),
  ];
}

describe('CLI multi-agent presets', () => {
  it('includes critical review in the mathematician team', () => {
    const preset = findPreset('mathematician');

    expect(preset.agents.workflow).toContain('criticize');
    expect(preset.texraHostedAgents).toContain('criticize');
  });

  it('preserves missing hosted provenance on a legacy custom preset', () => {
    // Legacy pair-shaped preset (pre-record recut): must normalize, not drop.
    const presets = teamPresets([
      {
        id: 'legacy',
        name: 'Legacy',
        description: 'Saved before hosted metadata existed',
        icon: 'screwdriver-wrench',
        workflowAgents: ['generic', 'polish'],
        toolUseAgents: ['orchestrator', 'review'],
      },
    ]);

    const legacy = findTeamPreset(presets, 'legacy');
    expect(legacy?.agents).toEqual({
      workflow: ['generic', 'polish'],
      toolUse: ['orchestrator', 'review'],
    });
    expect(legacy?.texraHostedAgents).toBeUndefined();
  });

  it('lists planned built-in team presets with stable counts', () => {
    const presets = teamPresets(undefined);
    const plans = planTeamRuns(presets, {
      agents: {
        workflow: presets.flatMap((preset) =>
          preset.agents.workflow.map((name) =>
            agent(name, AgentCategory.Workflow),
          ),
        ),
        toolUse: presets.flatMap((preset) =>
          preset.agents.toolUse.map((name) =>
            agent(
              name,
              AgentCategory.ToolUse,
              ['orchestrator', 'leanOrchestrator', 'engineer'].includes(name)
                ? ['delegate_agent']
                : [],
            ),
          ),
        ),
      },
    });

    expect(presets.map((preset) => preset.id)).toContain('physicist');
    const output = formatCliMultiAgentPresetList(plans);

    expect(output).toContain(
      'built-in\tphysicist\tPhysicist\tworkflow:6\ttool-use:9',
    );
    expect(output).not.toContain('Hint:');
  });

  it('lists missing preset members as unavailable when no team can launch', () => {
    const plan = partialLeanProjectPlan();

    const output = formatCliMultiAgentPresetList([plan]);

    expect(output).toContain(
      'built-in\tlean-project\tLean Project\ttool-use:2/7\tunavailable',
    );
    expect(output).not.toContain('workflow:0');
    expect(output).toContain('texra multi-agent show <team-id>');
    expect(output).toContain(
      'Researcher Access sign-in may load additional remote team agents',
    );
  });

  it('omits the login recovery hint after a remote agent load was attempted', () => {
    const plan = partialLeanProjectPlan();

    const output = formatCliMultiAgentPresetList([plan], {
      includeLoginHint: false,
    });

    expect(output).toContain('texra multi-agent show <team-id>');
    expect(output).not.toContain('after `texra login`');
  });

  it('marks missing team roots as unavailable', () => {
    const plan = partialLeanProjectPlan();

    expect(plan.rootAgent).toBeUndefined();
    expect(teamAvailability(plan).status).toBe('unavailable');
    expect(teamLaunchBlockReason(plan)).toBe('no runnable team root');
    expect(canLaunchTeam(plan)).toBe(false);
  });

  it('keeps degraded presets launchable when they still have delegation', () => {
    const plan = planRun(findPreset('physicist'), {
      toolUse: degradedPhysicistToolUse(),
    });

    expect(teamAvailability(plan).status).toBe('degraded');
    expect(canLaunchTeam(plan)).toBe(true);
  });

  it('formats compact launcher summaries from planned availability', () => {
    const plan = planRun(findPreset('physicist'), {
      workflow: [agent('correct', AgentCategory.Workflow)],
      toolUse: degradedPhysicistToolUse(),
    });

    expect(formatCliMultiAgentPresetLauncherSummary(plan)).toBe(
      'degraded; 1/6 workflows; 2/9 tools',
    );
    expect(formatCliMultiAgentPresetLauncherHints(plan)).toEqual([
      'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.',
      'Researcher Access sign-in may unlock more remote team agents.',
    ]);
  });

  it('formats run warnings from planned missing team members', () => {
    const plan = planRun(findPreset('physicist'), {
      toolUse: degradedPhysicistToolUse(),
    });

    expect(formatCliMultiAgentPresetRunWarnings(plan)).toEqual([
      'WARN preset physicist references unavailable agents: workflow:correct, workflow:polish, workflow:generic, workflow:devise, workflow:apply, workflow:criticize, tool-use:research, tool-use:numerics, tool-use:presenter, tool-use:simplifier, tool-use:latexFixer, tool-use:progressCheck, tool-use:search',
      'WARN preset physicist is degraded; running root agent orchestrator with 1 available team agent.',
    ]);
  });

  it('omits degraded run warnings when only the root is available', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      toolUse: [
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });

    expect(formatCliMultiAgentPresetRunWarnings(plan)).toEqual([
      'WARN preset physicist references unavailable agents: workflow:correct, workflow:polish, workflow:generic, workflow:devise, workflow:apply, workflow:criticize, tool-use:research, tool-use:numerics, tool-use:review, tool-use:presenter, tool-use:simplifier, tool-use:latexFixer, tool-use:progressCheck, tool-use:search',
    ]);
  });

  it('marks complete built-in teams available', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      workflow: preset.agents.workflow.map((name) =>
        agent(name, AgentCategory.Workflow),
      ),
      toolUse: toolUseTeam(preset, 'orchestrator'),
    });

    expect(teamAvailability(plan)).toMatchObject({
      status: 'available',
      agents: {
        toolUse: { available: 9, total: 9 },
        workflow: { available: 6, total: 6 },
      },
    });
  });

  it('launches the software-engineer team on its bundled engineer root', () => {
    const preset = findPreset('software-engineer');
    const plan = planRun(preset, {
      toolUse: toolUseTeam(preset, 'engineer'),
    });

    expect(plan.rootAgent?.name).toBe('engineer');
    expect(plan.missingAgents.toolUse).toEqual([]);
    expect(teamPlanHasGaps(plan)).toBe(false);
    expect(canLaunchTeam(plan)).toBe(true);
    expect(teamAvailability(plan).agents.toolUse).toMatchObject({
      available: 5,
      total: 5,
    });
  });

  it('keeps unavailable preset facts separate from launcher guidance', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      toolUse: [],
    });

    expect(teamAvailability(plan)).toMatchObject({
      status: 'unavailable',
      agents: {
        toolUse: { available: 0, total: 9 },
        workflow: { available: 0, total: 6 },
      },
    });
    expect(teamLaunchBlockReason(plan)).toBe('no runnable team root');
  });

  it('formats team launch block messages from the planned preset state', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      toolUse: [agent('lean', AgentCategory.ToolUse)],
    });

    expect(
      formatCliMultiAgentTeamLaunchBlockMessage(plan, {
        requestedPreset: 'Lean Project',
        followUpAdvice:
          'Install or sign in for a runnable team root before launching this preset.',
      }),
    ).toBe(
      'Multi-agent preset "Lean Project" cannot start as a team: no runnable team root. Run `texra multi-agent show lean-project` to see missing agents. Install or sign in for a runnable team root before launching this preset.',
    );
  });

  it('names an explicit non-delegating team root instead of saying it cannot delegate', () => {
    const preset = findPreset('mathematician');
    const plan = planRun(preset, {
      toolUse: [agent('lean', AgentCategory.ToolUse)],
      agentOverride: 'lean',
    });

    const message = formatCliMultiAgentTeamLaunchBlockMessage(plan, {
      requestedPreset: 'mathematician',
      followUpAdvice:
        'Start a single-agent chat with `texra chat --agent lean` if that is what you want.',
    });

    expect(message).toBe(
      'Multi-agent preset "mathematician" cannot start as a team: team root lean is not a delegating agent. Run `texra multi-agent show mathematician` to see missing agents. Start a single-agent chat with `texra chat --agent lean` if that is what you want.',
    );
    expect(message).not.toContain('cannot delegate');
  });

  it('rejects launch block message formatting for launchable plans', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      toolUse: toolUseTeam(preset, 'leanOrchestrator'),
    });

    expect(() => formatCliMultiAgentTeamLaunchBlockMessage(plan)).toThrow(
      /launchable multi-agent preset "lean-project"/,
    );
  });

  it('keeps built-in teams unavailable until their orchestrator root is present', () => {
    const plans = planTeamRuns(teamPresets(undefined), {
      agents: {
        workflow: [
          agent('correct', AgentCategory.Workflow),
          agent('polish', AgentCategory.Workflow),
        ],
        toolUse: [
          agent('lean', AgentCategory.ToolUse),
          agent('research', AgentCategory.ToolUse),
          agent('numerics', AgentCategory.ToolUse),
          agent('review', AgentCategory.ToolUse),
          agent('search', AgentCategory.ToolUse),
          agent('latexFixer', AgentCategory.ToolUse),
        ],
      },
    });

    const launchBlockReasons = new Map(
      plans.map((plan) => [plan.preset.id, teamLaunchBlockReason(plan)]),
    );

    expect(launchBlockReasons).toEqual(
      new Map([
        ['lean-project', 'no runnable team root'],
        ['physicist', 'no runnable team root'],
        ['mathematician', 'no runnable team root'],
        ['cs-ml', 'no runnable team root'],
        ['software-engineer', 'no runnable team root'],
      ]),
    );
  });

  it('serializes planned availability for machine-readable list output', () => {
    const preset = findPreset('lean-project');
    const record = cliMultiAgentPresetListRecord(partialLeanProjectPlan());

    expect(record.id).toBe('lean-project');
    expect(record.agents.toolUse).toEqual(preset.agents.toolUse);
    expect(record.availability).toMatchObject({
      status: 'unavailable',
      agents: {
        workflow: {
          available: 0,
          total: 0,
          missing: [],
          label: '0',
        },
        toolUse: {
          available: 2,
          total: 7,
          missing: [
            'leanSearch',
            'leanSimplifier',
            'leanBlueprint',
            'progressCheck',
            'leanOrchestrator',
          ],
          label: '2/7',
        },
      },
    });
    expect(record.availability.rootAgent).toBeUndefined();
  });

  it('includes planned availability in ndjson preset records', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      toolUse: [agent('lean', AgentCategory.ToolUse)],
    });

    expect(cliMultiAgentPresetNdjsonRecords([plan])).toEqual([
      expect.objectContaining({
        kind: 'multi-agent-preset',
        ts: expect.any(String),
        preset: expect.objectContaining({
          id: 'lean-project',
          availability: expect.objectContaining({
            status: 'unavailable',
            agents: expect.objectContaining({
              toolUse: expect.objectContaining({
                available: 1,
                total: 7,
                label: '1/7',
              }),
            }),
          }),
        }),
      }),
    ]);
  });

  it('loads valid custom team presets, drops structurally malformed state, and keeps unknown-icon teams', () => {
    const valid = [
      {
        id: 'custom-paper',
        name: 'Paper Team',
        description: 'For this paper',
        icon: 'codicon-bookmark',
        agents: {
          workflow: ['polish'],
          toolUse: ['review'],
        },
      },
    ];
    const customPresets = (raw: unknown) =>
      teamPresets(raw).filter((preset) => preset.source === 'custom');

    expect(customPresets(valid)).toEqual([
      {
        ...valid[0],
        icon: 'bookmark',
        source: 'custom',
      },
    ]);
    expect(customPresets([{ id: 'broken' }, ...valid])).toEqual([
      {
        ...valid[0],
        icon: 'bookmark',
        source: 'custom',
      },
    ]);

    // An unrecognized icon is cosmetic and must NOT cost the user the team:
    // these presets come from persisted workspace state that the next preset
    // save/delete rewrites wholesale, so dropping one here deleted it for good.
    // It degrades to `bookmark` with a warn instead. Structurally malformed
    // presets (below) are still dropped.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      customPresets([
        ...valid,
        {
          id: 'custom-broken-icon',
          name: 'Broken Icon',
          description: 'Structurally valid but uses an unknown icon.',
          icon: 'not-a-valid-icon',
          agents: {
            workflow: [],
            toolUse: [],
          },
        },
      ]),
    ).toEqual([
      {
        ...valid[0],
        icon: 'bookmark',
        source: 'custom',
      },
      {
        id: 'custom-broken-icon',
        name: 'Broken Icon',
        description: 'Structurally valid but uses an unknown icon.',
        icon: 'bookmark',
        agents: {
          workflow: [],
          toolUse: [],
        },
        source: 'custom',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('not-a-valid-icon'),
    );
    warn.mockRestore();

    expect(customPresets([{ id: 'broken' }])).toEqual([]);
  });

  it('finds presets by id, name, or slugified name', () => {
    const presets = teamPresets(undefined);

    expect(findTeamPreset(presets, 'PHYSICIST')?.name).toBe('Physicist');
    expect(findTeamPreset(presets, 'physicist')?.name).toBe('Physicist');
    expect(findTeamPreset(presets, 'Lean Project')?.id).toBe('lean-project');
    expect(findTeamPreset(presets, 'computer-scientist')?.id).toBe('cs-ml');
  });

  it('formats an inspection plan with root and missing members', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      workflow: [
        agent('correct', AgentCategory.Workflow),
        agent('polish', AgentCategory.Workflow),
      ],
      toolUse: [
        agent('review', AgentCategory.ToolUse),
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });
    const details = formatCliMultiAgentPresetInspection(plan);

    expect(details).toContain('Team root agent:\n  orchestrator');
    expect(details).toContain(
      'Available workflow agents:\n  correct\n  polish',
    );
    expect(details).toContain(
      'Available tool-use agents:\n  orchestrator\n  review',
    );
    expect(details).toContain(
      'Missing workflow agents:\n  generic\n  devise\n  apply\n  criticize',
    );
    expect(details).toContain(
      [
        'Missing tool-use agents:',
        '  research',
        '  numerics',
        '  presenter',
        '  simplifier',
        '  latexFixer',
        '  progressCheck',
        '  search',
        '',
        'Hint: Researcher Access sign-in may load additional remote team agents.',
      ].join('\n'),
    );
  });

  it('omits inspection login recovery hint after a remote agent load was attempted', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      toolUse: [agent('review', AgentCategory.ToolUse)],
    });

    const details = formatCliMultiAgentPresetInspection(plan, {
      includeLoginHint: false,
    });

    expect(details).toContain('Missing tool-use agents:');
    expect(details).not.toContain('after `texra login`');
  });

  it('plans a preset run with canonical visibility keys and an orchestrator root', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      workflow: [
        agent('correct', AgentCategory.Workflow),
        agent('polish', AgentCategory.Workflow),
      ],
      toolUse: [
        agent('review', AgentCategory.ToolUse),
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });

    expect(plan.rootAgent?.name).toBe('orchestrator');
    expect(plan.agentKeys.workflow).toEqual([
      'builtInWorkflow:correct',
      'builtInWorkflow:polish',
    ]);
    expect(plan.agentKeys.toolUse).toEqual([
      'builtInToolUse:orchestrator',
      'builtInToolUse:review',
    ]);
    expect(plan.missingAgents.toolUse).toContain('research');
  });

  it('flags a gap when a built-in preset has members but no root', () => {
    const preset = findPreset('physicist');
    // A local-only registry can expose team members before relay-served
    // orchestrators are available. The members should still count as available,
    // but they should not be promoted to the built-in team root.
    const plan = planRun(preset, {
      toolUse: [agent('review', AgentCategory.ToolUse)],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(teamPlanHasGaps(plan)).toBe(true);
  });

  it('does not select built-in team specialists as implicit roots', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      toolUse: [
        agent('review', AgentCategory.ToolUse),
        agent('simplifier', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });
    const onlySimplifierPlan = planRun(preset, {
      toolUse: [agent('simplifier', AgentCategory.ToolUse, ['delegate_agent'])],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(onlySimplifierPlan.rootAgent).toBeUndefined();
    expect(teamPlanHasGaps(onlySimplifierPlan)).toBe(true);
  });

  it('keeps delegating built-in specialists as members instead of roots', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      toolUse: [
        agent('lean', AgentCategory.ToolUse, ['delegate_agent']),
        agent('latexFixer', AgentCategory.ToolUse),
      ],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(teamLaunchBlockReason(plan)).toBe('no runnable team root');
  });

  it.each([
    {
      name: 'allows custom presets to default to a delegating member root',
      id: 'custom-review',
      members: ['review'],
      delegating: ['review'],
      rootAgent: 'review' as string | undefined,
      hasGaps: false,
    },
    {
      name: 'prefers custom preset order before built-in root fallbacks',
      id: 'custom-review',
      members: ['review', 'engineer'],
      delegating: ['review', 'engineer'],
      rootAgent: 'review' as string | undefined,
      hasGaps: false,
    },
    {
      name: 'does not infer a non-delegating root for custom presets',
      id: 'custom-review',
      members: ['review'],
      delegating: [],
      rootAgent: undefined,
      hasGaps: true,
    },
    {
      name: 'does not allow custom presets to default to their simplifier agent',
      id: 'custom-cleanup',
      members: ['simplifier'],
      delegating: ['simplifier'],
      rootAgent: undefined,
      hasGaps: true,
    },
  ])('$name', ({ id, members, delegating, rootAgent, hasGaps }) => {
    const plan = planRun(
      {
        id,
        name: id,
        description: 'User-authored team.',
        icon: 'cube',
        source: 'custom',
        agents: {
          workflow: [],
          toolUse: members,
        },
      },
      {
        toolUse: members.map((member) =>
          agent(
            member,
            AgentCategory.ToolUse,
            delegating.includes(member) ? ['delegate_agent'] : [],
          ),
        ),
      },
    );

    // Assert on rootAgent itself for the negative rows: `?.name` would also
    // pass for a root that was inferred but happens to have no name, which is
    // the regression these rows exist to catch.
    if (rootAgent === undefined) expect(plan.rootAgent).toBeUndefined();
    else expect(plan.rootAgent?.name).toBe(rootAgent);
    expect(teamPlanHasGaps(plan)).toBe(hasGaps);
  });

  it('reports no gaps when every preset member resolves', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      toolUse: toolUseTeam(preset, 'leanOrchestrator'),
    });

    expect(plan.rootAgent?.name).toBe('leanOrchestrator');
    expect(plan.missingAgents.toolUse).toEqual([]);
    expect(teamPlanHasGaps(plan)).toBe(false);
  });

  it('flags a gap when no root agent can be selected', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      toolUse: [],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(teamPlanHasGaps(plan)).toBe(true);
  });

  it('adds an explicit root override to the visible tool-use team', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      toolUse: [
        agent('lean', AgentCategory.ToolUse),
        agent('review', AgentCategory.ToolUse, ['delegate_agent']),
      ],
      agentOverride: 'review',
    });
    const sourceQualifiedPlan = planRun(preset, {
      toolUse: [
        agent('lean', AgentCategory.ToolUse),
        agent('review', AgentCategory.ToolUse, ['delegate_agent']),
      ],
      agentOverride: 'builtInToolUse:review',
    });

    expect(plan.rootAgent?.name).toBe('review');
    expect(plan.agentKeys.toolUse).toContain('builtInToolUse:review');
    expect(sourceQualifiedPlan.missingAgentOverride).toBeUndefined();
    expect(sourceQualifiedPlan.rootAgent?.name).toBe('review');
  });

  it('allows a preset member when explicitly requested as the root', () => {
    const preset = findPreset('physicist');
    const plan = planRun(preset, {
      toolUse: [
        agent('review', AgentCategory.ToolUse, ['delegate_agent']),
        agent('research', AgentCategory.ToolUse),
      ],
      agentOverride: 'review',
    });

    expect(plan.rootAgent?.name).toBe('review');
    expect(plan.agentKeys.toolUse).toContain('builtInToolUse:review');
  });

  it('tracks a missing root override as a plan gap', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      toolUse: toolUseTeam(preset, 'leanOrchestrator'),
      agentOverride: 'definitely-not-real',
    });

    expect(plan.missingAgentOverride).toBe('definitely-not-real');
    expect(plan.rootAgent?.name).toBe('leanOrchestrator');
    expect(plan.missingAgents.toolUse).toEqual([]);
    expect(teamPlanHasGaps(plan)).toBe(true);
  });
});
