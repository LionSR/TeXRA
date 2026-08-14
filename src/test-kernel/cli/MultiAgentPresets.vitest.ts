// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentEntry } from '@agent/index';
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
  findTeamPreset,
  planTeamRun,
  planTeamRuns,
  teamPlanHasGaps,
  teamPresets,
} from '@common/teams/TeamPlan';
import { AgentCategory } from '@shared/schemas';

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

// The physicist team with two workflows and the root-plus-review tool pair.
function partialPhysicistPlan(): CliMultiAgentPresetRunPlan {
  return planRun(findPreset('physicist'), {
    workflow: [
      agent('correct', AgentCategory.Workflow),
      agent('polish', AgentCategory.Workflow),
    ],
    toolUse: [
      agent('review', AgentCategory.ToolUse),
      agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
    ],
  });
}

describe('CLI multi-agent presets', () => {
  it('includes critical review in the mathematician team', () => {
    const preset = findPreset('mathematician');

    expect(preset.agents.workflow).toContain('criticize');
    expect(preset.texraHostedAgents).toContain('criticize');
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
    const expectedCustom = { ...valid[0], icon: 'bookmark', source: 'custom' };

    expect(customPresets(valid)).toEqual([expectedCustom]);
    expect(customPresets([{ id: 'broken' }, ...valid])).toEqual([
      expectedCustom,
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
      expectedCustom,
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

  it('formats an inspection plan with root and missing members', () => {
    const details = formatCliMultiAgentPresetInspection(partialPhysicistPlan());

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
    const plan = partialPhysicistPlan();

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

  it.each([
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
});
