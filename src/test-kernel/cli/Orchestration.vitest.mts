import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { orchestrationKeyHints } from '@cli/orchestration/runOrchestrationTui';
import { buildCliOrchestrationItems } from '@cli/runtime/orchestration';

import type { CliHistoryEntry } from '@cli/runtime/history';
import {
  planCliMultiAgentPresetRun,
  type CliMultiAgentPreset,
  type CliMultiAgentPresetRunPlan,
} from '@cli/runtime/multiAgentPresets';
import type { ExecutionId } from '@shared/schemas';

function historyEntry(
  id: string,
  overrides: Partial<CliHistoryEntry> = {},
): CliHistoryEntry {
  return {
    id: id as ExecutionId,
    timestamp: '2026-05-21T00:00:00Z',
    agent: 'orchestrator',
    model: 'claude-opus-4-7',
    status: 'completed',
    inputBasename: '-',
    category: AgentCategory.ToolUse,
    ...overrides,
  };
}

function agent(
  name: string,
  category: AgentCategory,
  tools: string[] = [],
): AgentEntry {
  return {
    name,
    description: `${name} agent`,
    category,
    source:
      category === AgentCategory.ToolUse ? 'builtInToolUse' : 'builtInWorkflow',
    path: `/agents/${name}.yaml`,
    tools,
  };
}

function toolUseAgent(name: string, tools: string[] = []): AgentEntry {
  return agent(name, AgentCategory.ToolUse, tools);
}

function workflowAgent(name: string): AgentEntry {
  return agent(name, AgentCategory.Workflow);
}

function preset(overrides: Partial<CliMultiAgentPreset>): CliMultiAgentPreset {
  return {
    id: 'physicist',
    name: 'Physicist',
    description: 'Physics team',
    icon: 'codicon-symbol-operator',
    workflowAgents: ['criticize'],
    toolUseAgents: ['orchestrator', 'review'],
    source: 'built-in',
    ...overrides,
  };
}

function presetPlan(
  overrides: Partial<CliMultiAgentPreset>,
  agents: {
    readonly workflowAgents?: readonly AgentEntry[];
    readonly toolUseAgents?: readonly AgentEntry[];
  } = {},
): CliMultiAgentPresetRunPlan {
  return planCliMultiAgentPresetRun(preset(overrides), {
    workflowAgents: agents.workflowAgents ?? [],
    toolUseAgents: agents.toolUseAgents ?? [],
  });
}

describe('CLI orchestration items', () => {
  it('advertises the full direct-open hotkey range used by Select', () => {
    expect(orchestrationKeyHints()).toContainEqual({
      key: '1-9/a-z/Enter',
      action: 'open',
    });
  });

  it('keeps the exit hint out of the Select letter hotkey range', () => {
    expect(orchestrationKeyHints()).toContainEqual({
      key: 'Esc',
      action: 'exit',
    });
    expect(orchestrationKeyHints()).not.toContainEqual({
      key: 'q/Esc',
      action: 'exit',
    });
  });

  it('starts with new chat and keeps help as the final active item', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [],
      toolUseAgents: [],
    });

    expect(items.at(0)).toMatchObject({
      label: 'New chat',
      value: { kind: 'chat' },
    });
    expect(items.at(-1)).toMatchObject({
      label: 'Help',
      value: { kind: 'help' },
    });
  });

  it('lists recent resumable executions before recent agents', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [
        historyEntry('aaaaaaaaaaaa', { agent: 'review' }),
        historyEntry('bbbbbbbbbbbb', { agent: 'orchestrator' }),
      ],
      toolUseAgents: [toolUseAgent('review'), toolUseAgent('orchestrator')],
    });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Resume aaaaaaaaaaaa',
      'Resume bbbbbbbbbbbb',
      'Chat with review',
      'Chat with orchestrator',
      'Help',
    ]);
  });

  it('filters recent agent entries to known tool-use agents', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [
        historyEntry('aaaaaaaaaaaa', {
          agent: 'polish',
          category: AgentCategory.Workflow,
        }),
        historyEntry('bbbbbbbbbbbb', { agent: 'missing' }),
        historyEntry('cccccccccccc', { agent: 'review' }),
      ],
      toolUseAgents: [toolUseAgent('review')],
    });

    expect(items.map((item) => item.label)).toContain('Chat with review');
    expect(items.map((item) => item.label)).not.toContain('Chat with polish');
    expect(items.map((item) => item.label)).not.toContain('Chat with missing');
  });

  it('lists team presets as runnable orchestration actions', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [
        presetPlan(
          { id: 'physicist' },
          {
            workflowAgents: [workflowAgent('criticize')],
            toolUseAgents: [
              toolUseAgent('orchestrator', ['delegate_agent']),
              toolUseAgent('review'),
            ],
          },
        ),
      ],
      history: [],
      toolUseAgents: [],
    });

    expect(items.find((item) => item.label === 'Team Physicist')).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({
          kind: 'preset',
          preset: 'physicist',
        }),
        description: 'built-in; workflow:1; tool-use:2',
      }),
    );
  });

  it('keeps team launch actions keyed by preset id only', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [presetPlan({ id: 'physicist', name: 'Physicist' })],
      history: [],
      toolUseAgents: [],
    });

    expect(
      items.find((item) => item.label === 'Team Physicist')?.value,
    ).toEqual({
      kind: 'preset',
      preset: 'physicist',
    });
  });
});
