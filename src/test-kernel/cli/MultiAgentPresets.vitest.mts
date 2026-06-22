import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  cliMultiAgentPresetAvailability,
  cliMultiAgentPlanHasGaps,
  cliMultiAgentPresetCanLaunchTeam,
  cliMultiAgentPresetListRecord,
  cliMultiAgentPresetNdjsonRecords,
  cliMultiAgentPresets,
  findCliMultiAgentPreset,
  formatCliMultiAgentPresetLauncherHints,
  formatCliMultiAgentPresetLauncherSummary,
  formatCliMultiAgentTeamLaunchBlockMessage,
  formatCliMultiAgentPresetDetails,
  formatCliMultiAgentPresetInspection,
  formatCliMultiAgentPresetList,
  formatCliMultiAgentPresetRunWarnings,
  cliMultiAgentPresetTeamLaunchBlockReason,
  planCliMultiAgentPresets,
  planCliMultiAgentPresetRun,
} from '@cli/runtime/multiAgentPresets';

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

describe('CLI multi-agent presets', () => {
  it('lists planned built-in team presets with stable counts', () => {
    const presets = cliMultiAgentPresets(undefined);
    const plans = planCliMultiAgentPresets(presets, {
      workflowAgents: presets.flatMap((preset) =>
        preset.workflowAgents.map((name) =>
          agent(name, AgentCategory.Workflow),
        ),
      ),
      toolUseAgents: presets.flatMap((preset) =>
        preset.toolUseAgents.map((name) =>
          agent(
            name,
            AgentCategory.ToolUse,
            ['orchestrator', 'leanOrchestrator', 'engineer'].includes(name)
              ? ['delegate_agent']
              : [],
          ),
        ),
      ),
    });

    expect(presets.map((preset) => preset.id)).toContain('physicist');
    const output = formatCliMultiAgentPresetList(plans);

    expect(output).toContain(
      'built-in\tphysicist\tPhysicist\tworkflow:4\ttool-use:9',
    );
    expect(output).not.toContain('Hint:');
  });

  it('lists missing preset members as unavailable when no team can launch', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse),
        agent('latexFixer', AgentCategory.ToolUse),
      ],
    });

    const output = formatCliMultiAgentPresetList([plan]);

    expect(output).toContain(
      'built-in\tlean-project\tLean Project\ttool-use:2/7\tunavailable',
    );
    expect(output).not.toContain('workflow:0');
    expect(output).toContain('texra multi-agent inspect <team-id>');
    expect(output).toContain(
      'Researcher Access sign-in may load additional remote team agents',
    );
  });

  it('omits the login recovery hint after a remote agent load was attempted', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse),
        agent('latexFixer', AgentCategory.ToolUse),
      ],
    });

    const output = formatCliMultiAgentPresetList([plan], {
      includeLoginHint: false,
    });

    expect(output).toContain('texra multi-agent inspect <team-id>');
    expect(output).not.toContain('after `texra login`');
  });

  it('marks missing team roots as unavailable', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse),
        agent('latexFixer', AgentCategory.ToolUse),
      ],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(cliMultiAgentPresetAvailability(plan).status).toBe('unavailable');
    expect(cliMultiAgentPresetTeamLaunchBlockReason(plan)).toBe(
      'no runnable team root',
    );
    expect(cliMultiAgentPresetCanLaunchTeam(plan)).toBe(false);
  });

  it('keeps degraded presets launchable when they still have delegation', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
        agent('review', AgentCategory.ToolUse),
      ],
    });

    expect(cliMultiAgentPresetAvailability(plan).status).toBe('degraded');
    expect(cliMultiAgentPresetCanLaunchTeam(plan)).toBe(true);
  });

  it('formats compact launcher summaries from planned availability', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [agent('criticize', AgentCategory.Workflow)],
      toolUseAgents: [
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
        agent('review', AgentCategory.ToolUse),
      ],
    });

    expect(formatCliMultiAgentPresetLauncherSummary(plan)).toBe(
      'degraded; 1/4 workflows; 2/9 tools',
    );
    expect(formatCliMultiAgentPresetLauncherHints(plan)).toEqual([
      'Team setup: run `texra multi-agent inspect <team-id>` for unavailable or degraded teams.',
      'Researcher Access sign-in may unlock more remote team agents.',
    ]);
  });

  it('formats run warnings from planned missing team members', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
        agent('review', AgentCategory.ToolUse),
      ],
    });

    expect(formatCliMultiAgentPresetRunWarnings(plan)).toEqual([
      'WARN preset physicist references unavailable agents: workflow:criticize, workflow:generic, workflow:devise, workflow:apply, tool-use:research, tool-use:numerics, tool-use:search, tool-use:presenter, tool-use:simplifier, tool-use:latexFixer, tool-use:progressCheck',
      'WARN preset physicist is degraded; running root agent orchestrator with 1 available team agent.',
    ]);
  });

  it('omits degraded run warnings when only the root is available', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });

    expect(formatCliMultiAgentPresetRunWarnings(plan)).toEqual([
      'WARN preset physicist references unavailable agents: workflow:criticize, workflow:generic, workflow:devise, workflow:apply, tool-use:research, tool-use:numerics, tool-use:review, tool-use:search, tool-use:presenter, tool-use:simplifier, tool-use:latexFixer, tool-use:progressCheck',
    ]);
  });

  it('marks complete built-in teams available', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: preset.workflowAgents.map((name) =>
        agent(name, AgentCategory.Workflow),
      ),
      toolUseAgents: preset.toolUseAgents.map((name) =>
        agent(
          name,
          AgentCategory.ToolUse,
          name === 'orchestrator' ? ['delegate_agent'] : [],
        ),
      ),
    });

    expect(cliMultiAgentPresetAvailability(plan)).toMatchObject({
      status: 'available',
      toolUse: { available: 9, total: 9 },
      workflow: { available: 4, total: 4 },
    });
  });

  it('launches the software-engineer team on its bundled engineer root', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'software-engineer',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: preset.toolUseAgents.map((name) =>
        agent(
          name,
          AgentCategory.ToolUse,
          name === 'engineer' ? ['delegate_agent'] : [],
        ),
      ),
    });

    expect(plan.rootAgent?.name).toBe('engineer');
    expect(plan.missingToolUseAgents).toEqual([]);
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(false);
    expect(cliMultiAgentPresetCanLaunchTeam(plan)).toBe(true);
    expect(cliMultiAgentPresetAvailability(plan).toolUse).toMatchObject({
      available: 5,
      total: 5,
    });
  });

  it('keeps unavailable preset facts separate from launcher guidance', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [],
    });

    expect(cliMultiAgentPresetAvailability(plan)).toMatchObject({
      status: 'unavailable',
      toolUse: { available: 0, total: 9 },
      workflow: { available: 0, total: 4 },
    });
    expect(cliMultiAgentPresetTeamLaunchBlockReason(plan)).toBe(
      'no runnable team root',
    );
  });

  it('formats team launch block messages from the planned preset state', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [agent('lean', AgentCategory.ToolUse)],
    });

    expect(
      formatCliMultiAgentTeamLaunchBlockMessage(plan, {
        requestedPreset: 'Lean Project',
        followUpAdvice:
          'Install or sign in for a runnable team root before launching this preset.',
      }),
    ).toBe(
      'Multi-agent preset "Lean Project" cannot start as a team: no runnable team root. Run `texra multi-agent inspect lean-project` to see missing agents. Install or sign in for a runnable team root before launching this preset.',
    );
  });

  it('formats explicit non-delegating team roots without old fallback wording', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'mathematician',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [agent('lean', AgentCategory.ToolUse)],
      agentOverride: 'lean',
    });

    const message = formatCliMultiAgentTeamLaunchBlockMessage(plan, {
      requestedPreset: 'mathematician',
      followUpAdvice:
        'Start a single-agent chat with `texra chat --agent lean` if that is what you want.',
    });

    expect(message).toBe(
      'Multi-agent preset "mathematician" cannot start as a team: team root lean is not a delegating agent. Run `texra multi-agent inspect mathematician` to see missing agents. Start a single-agent chat with `texra chat --agent lean` if that is what you want.',
    );
    expect(message).not.toContain('cannot delegate');
  });

  it('rejects launch block message formatting for launchable plans', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: preset.toolUseAgents.map((name) =>
        agent(
          name,
          AgentCategory.ToolUse,
          name === 'leanOrchestrator' ? ['delegate_agent'] : [],
        ),
      ),
    });

    expect(() => formatCliMultiAgentTeamLaunchBlockMessage(plan)).toThrow(
      /launchable multi-agent preset "lean-project"/,
    );
  });

  it('keeps built-in teams unavailable until their orchestrator root is present', () => {
    const plans = planCliMultiAgentPresets(cliMultiAgentPresets(undefined), {
      workflowAgents: [
        agent('correct', AgentCategory.Workflow),
        agent('polish', AgentCategory.Workflow),
      ],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse),
        agent('research', AgentCategory.ToolUse),
        agent('numerics', AgentCategory.ToolUse),
        agent('review', AgentCategory.ToolUse),
        agent('search', AgentCategory.ToolUse),
        agent('latexFixer', AgentCategory.ToolUse),
      ],
    });

    const launchBlockReasons = new Map(
      plans.map((plan) => [
        plan.preset.id,
        cliMultiAgentPresetTeamLaunchBlockReason(plan),
      ]),
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
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse),
        agent('latexFixer', AgentCategory.ToolUse),
      ],
    });
    const record = cliMultiAgentPresetListRecord(plan);

    expect(record.id).toBe('lean-project');
    expect(record.toolUseAgents).toEqual(preset.toolUseAgents);
    expect(record.availability).toMatchObject({
      status: 'unavailable',
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
    });
    expect(record.availability.rootAgent).toBeUndefined();
  });

  it('includes planned availability in ndjson preset records', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [agent('lean', AgentCategory.ToolUse)],
    });

    expect(cliMultiAgentPresetNdjsonRecords([plan])).toEqual([
      expect.objectContaining({
        kind: 'multi-agent-preset',
        ts: expect.any(String),
        preset: expect.objectContaining({
          id: 'lean-project',
          availability: expect.objectContaining({
            status: 'unavailable',
            toolUse: expect.objectContaining({
              available: 1,
              total: 7,
              label: '1/7',
            }),
          }),
        }),
      }),
    ]);
  });

  it('loads valid custom team presets and ignores invalid state', () => {
    const valid = [
      {
        id: 'custom-paper',
        name: 'Paper Team',
        description: 'For this paper',
        icon: 'codicon-bookmark',
        workflowAgents: ['polish'],
        toolUseAgents: ['review'],
      },
    ];
    const customPresets = (raw: unknown) =>
      cliMultiAgentPresets(raw).filter((preset) => preset.source === 'custom');

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
    expect(
      customPresets([
        ...valid,
        {
          id: 'custom-broken-icon',
          name: 'Broken Icon',
          description: 'Structurally valid but uses an unknown icon.',
          icon: 'not-a-valid-icon',
          workflowAgents: [],
          toolUseAgents: [],
        },
      ]),
    ).toEqual([
      {
        ...valid[0],
        icon: 'bookmark',
        source: 'custom',
      },
    ]);
    expect(customPresets([{ id: 'broken' }])).toEqual([]);
  });

  it('finds presets by id, name, or slugified name', () => {
    const presets = cliMultiAgentPresets(undefined);

    expect(findCliMultiAgentPreset(presets, 'PHYSICIST')?.name).toBe(
      'Physicist',
    );
    expect(findCliMultiAgentPreset(presets, 'physicist')?.name).toBe(
      'Physicist',
    );
    expect(findCliMultiAgentPreset(presets, 'Lean Project')?.id).toBe(
      'lean-project',
    );
    expect(findCliMultiAgentPreset(presets, 'computer-scientist')?.id).toBe(
      'cs-ml',
    );
  });

  it('formats details without dropping empty agent categories', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    );

    expect(formatCliMultiAgentPresetDetails(preset!)).toContain(
      'Workflow agents:\n  (none)',
    );
    expect(formatCliMultiAgentPresetDetails(preset!)).toContain(
      'Tool-use agents:\n  lean',
    );
  });

  it('formats an inspection plan with root and missing members', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [
        agent('criticize', AgentCategory.Workflow),
        agent('generic', AgentCategory.Workflow),
      ],
      toolUseAgents: [
        agent('review', AgentCategory.ToolUse),
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });
    const details = formatCliMultiAgentPresetInspection(plan);

    expect(details).toContain('Team root agent:\n  orchestrator');
    expect(details).toContain(
      'Available workflow agents:\n  criticize\n  generic',
    );
    expect(details).toContain(
      'Available tool-use agents:\n  orchestrator\n  review',
    );
    expect(details).toContain('Missing workflow agents:\n  devise\n  apply');
    expect(details).toContain(
      [
        'Missing tool-use agents:',
        '  research',
        '  numerics',
        '  search',
        '  presenter',
        '  simplifier',
        '  latexFixer',
        '  progressCheck',
        '',
        'Hint: Researcher Access sign-in may load additional remote team agents.',
      ].join('\n'),
    );
  });

  it('omits inspection login recovery hint after a remote agent load was attempted', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [agent('review', AgentCategory.ToolUse)],
    });

    const details = formatCliMultiAgentPresetInspection(plan, {
      includeLoginHint: false,
    });

    expect(details).toContain('Missing tool-use agents:');
    expect(details).not.toContain('after `texra login`');
  });

  it('plans a preset run with canonical visibility keys and an orchestrator root', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [
        agent('criticize', AgentCategory.Workflow),
        agent('generic', AgentCategory.Workflow),
        agent('devise', AgentCategory.Workflow),
        agent('apply', AgentCategory.Workflow),
      ],
      toolUseAgents: [
        agent('review', AgentCategory.ToolUse),
        agent('orchestrator', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });

    expect(plan.rootAgent?.name).toBe('orchestrator');
    expect(plan.workflowAgentKeys).toEqual([
      'builtInWorkflow:criticize',
      'builtInWorkflow:generic',
      'builtInWorkflow:devise',
      'builtInWorkflow:apply',
    ]);
    expect(plan.toolUseAgentKeys).toEqual([
      'builtInToolUse:orchestrator',
      'builtInToolUse:review',
    ]);
    expect(plan.missingToolUseAgents).toContain('research');
  });

  it('flags a gap when a built-in preset has members but no root', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    // A local-only registry can expose team members before relay-served
    // orchestrators are available. The members should still count as available,
    // but they should not be promoted to the built-in team root.
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [agent('review', AgentCategory.ToolUse)],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(true);
  });

  it('does not select built-in team specialists as implicit roots', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('review', AgentCategory.ToolUse),
        agent('simplifier', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });
    const onlySimplifierPlan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('simplifier', AgentCategory.ToolUse, ['delegate_agent']),
      ],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(onlySimplifierPlan.rootAgent).toBeUndefined();
    expect(cliMultiAgentPlanHasGaps(onlySimplifierPlan)).toBe(true);
  });

  it('keeps delegating built-in specialists as members instead of roots', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse, ['delegate_agent']),
        agent('latexFixer', AgentCategory.ToolUse),
      ],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(cliMultiAgentPresetTeamLaunchBlockReason(plan)).toBe(
      'no runnable team root',
    );
  });

  it('allows custom presets to default to a delegating member root', () => {
    const plan = planCliMultiAgentPresetRun(
      {
        id: 'custom-review',
        name: 'Custom review',
        description: 'User-authored review team.',
        icon: 'symbol-method',
        source: 'custom',
        workflowAgents: [],
        toolUseAgents: ['review'],
      },
      {
        workflowAgents: [],
        toolUseAgents: [
          agent('review', AgentCategory.ToolUse, ['delegate_agent']),
        ],
      },
    );

    expect(plan.rootAgent?.name).toBe('review');
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(false);
  });

  it('prefers custom preset order before built-in root fallbacks', () => {
    const plan = planCliMultiAgentPresetRun(
      {
        id: 'custom-review',
        name: 'Custom review',
        description: 'User-authored review team.',
        icon: 'symbol-method',
        source: 'custom',
        workflowAgents: [],
        toolUseAgents: ['review', 'engineer'],
      },
      {
        workflowAgents: [],
        toolUseAgents: [
          agent('review', AgentCategory.ToolUse, ['delegate_agent']),
          agent('engineer', AgentCategory.ToolUse, ['delegate_agent']),
        ],
      },
    );

    expect(plan.rootAgent?.name).toBe('review');
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(false);
  });

  it('does not infer a non-delegating root for custom presets', () => {
    const plan = planCliMultiAgentPresetRun(
      {
        id: 'custom-review',
        name: 'Custom review',
        description: 'User-authored review team.',
        icon: 'symbol-method',
        source: 'custom',
        workflowAgents: [],
        toolUseAgents: ['review'],
      },
      {
        workflowAgents: [],
        toolUseAgents: [agent('review', AgentCategory.ToolUse)],
      },
    );

    expect(plan.rootAgent).toBeUndefined();
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(true);
  });

  it('does not allow custom presets to default to their simplifier agent', () => {
    const plan = planCliMultiAgentPresetRun(
      {
        id: 'custom-cleanup',
        name: 'Custom cleanup',
        description: 'User-authored cleanup team.',
        icon: 'symbol-method',
        source: 'custom',
        workflowAgents: [],
        toolUseAgents: ['simplifier'],
      },
      {
        workflowAgents: [],
        toolUseAgents: [
          agent('simplifier', AgentCategory.ToolUse, ['delegate_agent']),
        ],
      },
    );

    expect(plan.rootAgent).toBeUndefined();
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(true);
  });

  it('reports no gaps when every preset member resolves', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: preset.toolUseAgents.map((name) =>
        agent(
          name,
          AgentCategory.ToolUse,
          name === 'leanOrchestrator' ? ['delegate_agent'] : [],
        ),
      ),
    });

    expect(plan.rootAgent?.name).toBe('leanOrchestrator');
    expect(plan.missingToolUseAgents).toEqual([]);
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(false);
  });

  it('flags a gap when no root agent can be selected', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [],
    });

    expect(plan.rootAgent).toBeUndefined();
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(true);
  });

  it('adds an explicit root override to the visible tool-use team', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse),
        agent('review', AgentCategory.ToolUse, ['delegate_agent']),
      ],
      agentOverride: 'review',
    });
    const sourceQualifiedPlan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('lean', AgentCategory.ToolUse),
        agent('review', AgentCategory.ToolUse, ['delegate_agent']),
      ],
      agentOverride: 'builtInToolUse:review',
    });

    expect(plan.rootAgent?.name).toBe('review');
    expect(plan.toolUseAgentKeys).toContain('builtInToolUse:review');
    expect(sourceQualifiedPlan.missingAgentOverride).toBeUndefined();
    expect(sourceQualifiedPlan.rootAgent?.name).toBe('review');
  });

  it('allows simplifier when explicitly requested as the preset root', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [
        agent('review', AgentCategory.ToolUse),
        agent('simplifier', AgentCategory.ToolUse, ['delegate_agent']),
      ],
      agentOverride: 'simplifier',
    });

    expect(plan.rootAgent?.name).toBe('simplifier');
    expect(plan.toolUseAgentKeys).toContain('builtInToolUse:simplifier');
  });

  it('tracks a missing root override as a plan gap', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'lean-project',
    )!;
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: preset.toolUseAgents.map((name) =>
        agent(
          name,
          AgentCategory.ToolUse,
          name === 'leanOrchestrator' ? ['delegate_agent'] : [],
        ),
      ),
      agentOverride: 'definitely-not-real',
    });

    expect(plan.missingAgentOverride).toBe('definitely-not-real');
    expect(plan.rootAgent?.name).toBe('leanOrchestrator');
    expect(plan.missingToolUseAgents).toEqual([]);
    expect(cliMultiAgentPlanHasGaps(plan)).toBe(true);
  });
});
