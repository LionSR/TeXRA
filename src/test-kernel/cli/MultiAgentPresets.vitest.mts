import { describe, expect, it } from 'vitest';

import {
  cliMultiAgentPlanHasGaps,
  cliMultiAgentPresets,
  findCliMultiAgentPreset,
  formatCliMultiAgentPresetDetails,
  formatCliMultiAgentPresetList,
  planCliMultiAgentPresetRun,
  parseCliCustomAgentPresets,
} from '@cli/runtime/multiAgentPresets';
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';

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
  it('lists built-in team presets with stable counts', () => {
    const presets = cliMultiAgentPresets(undefined);

    expect(presets.map((preset) => preset.id)).toContain('physicist');
    expect(formatCliMultiAgentPresetList(presets)).toContain(
      'built-in\tphysicist\tPhysicist\tworkflow:4\ttool-use:9',
    );
  });

  it('parses valid custom team presets and ignores invalid state', () => {
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

    expect(parseCliCustomAgentPresets(valid)).toEqual(valid);
    expect(parseCliCustomAgentPresets([{ id: 'broken' }])).toEqual([]);
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
    expect(
      findCliMultiAgentPreset(presets, 'computer-scientist-(ml)')?.id,
    ).toBe('cs-ml');
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

  it('flags a gap when the preset has a root but missing members', () => {
    const preset = findCliMultiAgentPreset(
      cliMultiAgentPresets(undefined),
      'physicist',
    )!;
    // A local-only registry: `review` can serve as root, but the orchestrator
    // and the rest of the team are absent. The run should still be treated as
    // having gaps so an authenticated user triggers a remote load.
    const plan = planCliMultiAgentPresetRun(preset, {
      workflowAgents: [],
      toolUseAgents: [agent('review', AgentCategory.ToolUse)],
    });

    expect(plan.rootAgent?.name).toBe('review');
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

    expect(plan.rootAgent?.name).toBe('review');
    expect(plan.toolUseAgentKeys).toContain('builtInToolUse:review');
  });
});
