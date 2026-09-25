// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentEntry } from '@agent/index';
import {
  cliMultiAgentPresetListRecord,
  formatCliMultiAgentTeamLaunchBlockMessage,
  type CliMultiAgentPresetRunPlan,
} from '@cli/runtime/multiAgentPresets';
import { planTeamRun, teamPlanHasGaps } from '@common/teams/TeamPlan';
import { findTeamPreset, teamPresets } from '@common/teams/TeamPresets';
import {
  AgentCategory,
  agentMatchesIdentifier,
  type ByCategory,
} from '@shared/schemas';

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

function planRun(
  preset: TeamPreset,
  options: Partial<ByCategory<readonly AgentEntry[]>> & {
    agentOverride?: string;
  } = {},
) {
  const { agentOverride, ...agents } = options;
  return planTeamRunForAgentEntry(preset, {
    resolveAgent: (category, identifier) =>
      agents[category]?.find((entry) =>
        agentMatchesIdentifier(entry, identifier),
      ),
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

  it('loads valid custom team presets and drops malformed state', () => {
    const valid = [
      {
        id: 'custom-paper',
        name: 'Paper Team',
        description: 'For this paper',
        icon: 'bookmark',
        agents: {
          workflow: ['polish'],
          toolUse: ['review'],
        },
        texraHostedAgents: [],
      },
    ];
    const customPresets = (raw: unknown) =>
      teamPresets(raw).filter((preset) => preset.source === 'custom');
    const expectedCustom = { ...valid[0], source: 'custom' };

    expect(customPresets(valid)).toEqual([expectedCustom]);
    expect(customPresets([{ id: 'broken' }, ...valid])).toEqual([
      expectedCustom,
    ]);
    expect(customPresets([{ id: 'broken' }])).toEqual([]);
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
        texraHostedAgents: [],
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
