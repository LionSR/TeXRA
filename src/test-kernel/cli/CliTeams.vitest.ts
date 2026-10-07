// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentEntry } from '@agent/index';
import {
  cliTeamListRecord,
  formatCliTeamLaunchBlockMessage,
  type CliTeamRunPlan,
} from '@cli/runtime/cliTeams';
import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset, teamPresets } from '@common/teams/TeamPresets';
import { DocumentTaskSchema, PersonaSchema } from '@shared/schemas';
import { agentMatchesIdentifier } from '@shared/schemas';

function agent(name: string, tools: string[] = []): AgentEntry {
  return {
    name,
    source: 'builtIn',
    path: `/agents/${name}.yaml`,
    tools,
    persona: PersonaSchema.parse({}),
    task: null,
  };
}

/** An agent that is also a document task. */
function taskAgent(name: string): AgentEntry {
  return {
    ...agent(name),
    task: DocumentTaskSchema.parse({ requests: ['Revise.'] }),
  };
}

function findPreset(id: string) {
  return findTeamPreset(teamPresets(undefined), id)!;
}

// `AgentEntry`-pinned so the derived parameter/return types below match
// `CliTeamRunPlan` instead of the unpinned `TeamCatalogAgent` bound.
const planTeamRunForAgentEntry = planTeamRun<AgentEntry>;
type TeamPreset = Parameters<typeof planTeamRunForAgentEntry>[0];

function planRun(
  preset: TeamPreset,
  options: { agents?: readonly AgentEntry[]; agentOverride?: string } = {},
) {
  const { agentOverride, agents = [] } = options;
  return planTeamRunForAgentEntry(preset, {
    resolveAgent: (identifier) =>
      agents.find((entry) => agentMatchesIdentifier(entry, identifier)),
    agentOverride,
  });
}

// The full agent list of a preset, with only `root` able to delegate.
function fullTeam(preset: TeamPreset, root: string): AgentEntry[] {
  return preset.agents.map((name) =>
    agent(name, name === root ? ['agent'] : []),
  );
}

// The lean-project team with two of its seven members and no delegating root.
function partialLeanProjectPlan(): CliTeamRunPlan {
  return planRun(findPreset('lean-project'), {
    agents: [agent('lean'), agent('latexFixer')],
  });
}

// The physicist team with two document tasks and the root-plus-review pair.
function partialPhysicistPlan(): CliTeamRunPlan {
  return planRun(findPreset('physicist'), {
    agents: [
      taskAgent('correct'),
      taskAgent('polish'),
      agent('review'),
      agent('orchestrator', ['agent']),
    ],
  });
}

describe('CLI teams', () => {
  it('names an explicit non-delegating team root instead of saying it cannot delegate', () => {
    const preset = findPreset('mathematician');
    const plan = planRun(preset, {
      agents: [agent('lean')],
      agentOverride: 'lean',
    });

    const message = formatCliTeamLaunchBlockMessage(plan, {
      requestedTeam: 'mathematician',
      followUpAdvice:
        'Start a single-agent chat with `texra chat --agent lean` if that is what you want.',
    });

    expect(message).toBe(
      'Team "mathematician" cannot start: team root lean is not a delegating agent. Run `texra team show mathematician` to see missing agents. Start a single-agent chat with `texra chat --agent lean` if that is what you want.',
    );
    expect(message).not.toContain('cannot delegate');
  });

  it('rejects launch block message formatting for launchable plans', () => {
    const preset = findPreset('lean-project');
    const plan = planRun(preset, {
      agents: fullTeam(preset, 'leanOrchestrator'),
    });

    expect(() => formatCliTeamLaunchBlockMessage(plan)).toThrow(
      /launchable team "lean-project"/,
    );
  });

  it('serializes planned availability for machine-readable list output', () => {
    const preset = findPreset('lean-project');
    const record = cliTeamListRecord(partialLeanProjectPlan());

    expect(record.id).toBe('lean-project');
    expect(record.agents).toEqual(preset.agents);
    expect(record.availability).toMatchObject({
      status: 'unavailable',
      agents: {
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
        agents: ['polish', 'review'],
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
    expect(plan.agentKeys).toEqual([
      'builtIn:orchestrator',
      'builtIn:review',
      'builtIn:correct',
      'builtIn:polish',
    ]);
    expect(plan.missingAgents).toContain('research');
  });

  it.each([
    {
      name: 'prefers custom preset order before built-in root fallbacks',
      id: 'custom-review',
      members: ['review', 'engineer'],
      delegating: ['review', 'engineer'],
      rootAgent: 'review' as string | undefined,
    },
    {
      name: 'does not infer a non-delegating root for custom presets',
      id: 'custom-review',
      members: ['review'],
      delegating: [],
      rootAgent: undefined,
    },
    {
      name: 'does not allow custom presets to default to their simplifier agent',
      id: 'custom-cleanup',
      members: ['simplifier'],
      delegating: ['simplifier'],
      rootAgent: undefined,
    },
  ])('$name', ({ id, members, delegating, rootAgent }) => {
    const plan = planRun(
      {
        id,
        name: id,
        description: 'User-authored team.',
        icon: 'cube',
        source: 'custom',
        agents: members,
      },
      {
        agents: members.map((member) =>
          agent(member, delegating.includes(member) ? ['agent'] : []),
        ),
      },
    );

    // Assert on rootAgent itself for the negative rows: `?.name` would also
    // pass for a root that was inferred but happens to have no name, which is
    // the regression these rows exist to catch.
    if (rootAgent === undefined) expect(plan.rootAgent).toBeUndefined();
    else expect(plan.rootAgent?.name).toBe(rootAgent);
  });
});
