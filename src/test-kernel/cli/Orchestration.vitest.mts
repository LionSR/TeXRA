import { describe, expect, it } from 'vitest';

import { buildCliOrchestrationItems } from '@cli/runtime/orchestration';
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@shared/schemas';

import type { CliHistoryEntry } from '@cli/runtime/history';
import type { CliMultiAgentPreset } from '@cli/runtime/multiAgentPresets';

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

function toolUseAgent(name: string): AgentEntry {
  return {
    name,
    description: `${name} agent`,
    tools: [],
  } as unknown as AgentEntry;
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

describe('CLI orchestration items', () => {
  it('starts with new chat and keeps help as the final active item', () => {
    const items = buildCliOrchestrationItems({
      presets: [],
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
      presets: [],
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
      presets: [],
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
      presets: [preset({ id: 'physicist' })],
      history: [],
      toolUseAgents: [],
    });

    expect(items.find((item) => item.label === 'Team Physicist')).toEqual(
      expect.objectContaining({
        value: { kind: 'preset', preset: 'physicist' },
        description: 'built-in; workflow:1; tool-use:2',
      }),
    );
  });
});
