import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  orchestrationFooterHints,
  orchestrationKeyHints,
  orchestrationModelAccessView,
} from '@cli/orchestration/runOrchestrationTui';
import { buildCliOrchestrationItems } from '@cli/runtime/orchestration';

import {
  CLI_HISTORY_RESUMABLE_STATUS,
  type CliHistoryEntry,
} from '@cli/runtime/history';
import type { CliModelAccess } from '@cli/runtime/modelAccess';
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

function modelAccess(
  value: string,
  availability: CliModelAccess['model']['availability'],
  available: boolean,
  status = available ? 'available' : 'missing key',
): CliModelAccess {
  return {
    model: { value, label: value, availability },
    available,
    status,
  };
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

function readyPresetPlan(
  overrides: Partial<CliMultiAgentPreset> = {},
): CliMultiAgentPresetRunPlan {
  return presetPlan(
    { id: 'physicist', name: 'Physicist', ...overrides },
    {
      workflowAgents: [workflowAgent('criticize')],
      toolUseAgents: [
        toolUseAgent('orchestrator', ['delegate_agent']),
        toolUseAgent('review'),
      ],
    },
  );
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
        historyEntry('aaaaaaaaaaaa', {
          agent: 'review',
          status: CLI_HISTORY_RESUMABLE_STATUS,
        }),
        historyEntry('bbbbbbbbbbbb', {
          agent: 'orchestrator',
          status: CLI_HISTORY_RESUMABLE_STATUS,
        }),
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
    expect(items[1]?.description).toBe('review; resumable; no input');
    expect(items[2]?.description).toBe('orchestrator; resumable; no input');
  });

  it('hides delegated child executions from startup recent rows', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [
        historyEntry('aaaaaaaaaaaa', {
          agent: 'search',
          status: CLI_HISTORY_RESUMABLE_STATUS,
          parentExecutionId: 'root-session' as ExecutionId,
          delegationDepth: 1,
        }),
        historyEntry('bbbbbbbbbbbb', {
          agent: 'review',
          status: CLI_HISTORY_RESUMABLE_STATUS,
          delegationDepth: 1,
        }),
        historyEntry('cccccccccccc', {
          agent: 'orchestrator',
          status: CLI_HISTORY_RESUMABLE_STATUS,
        }),
      ],
      toolUseAgents: [
        toolUseAgent('search'),
        toolUseAgent('review'),
        toolUseAgent('orchestrator'),
      ],
    });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Resume cccccccccccc',
      'Chat with orchestrator',
      'Help',
    ]);
  });

  it('does not list completed executions as resume launcher rows', () => {
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
      'Chat with review',
      'Chat with orchestrator',
      'Help',
    ]);
  });

  it('uses the input file name in resume launcher rows when present', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [
        historyEntry('aaaaaaaaaaaa', {
          agent: 'review',
          status: CLI_HISTORY_RESUMABLE_STATUS,
          inputBasename: 'paper.tex',
        }),
      ],
      toolUseAgents: [toolUseAgent('review')],
    });

    expect(items[1]?.description).toBe('review; resumable; paper.tex');
  });

  it('uses the history description for resume launcher rows without input files', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [
        historyEntry('aaaaaaaaaaaa', {
          agent: 'chat',
          status: CLI_HISTORY_RESUMABLE_STATUS,
          inputBasename: '-',
          description: 'Sketching inductive Lean proof of Nat.add_comm.',
        }),
      ],
      toolUseAgents: [toolUseAgent('chat')],
    });

    expect(items[1]?.description).toBe(
      'chat; resumable; Sketching inductive Lean proof of Nat.add_comm.',
    );
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

  it('does not offer simplifier as an inferred startup chat agent', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [
        historyEntry('aaaaaaaaaaaa', { agent: 'simplifier' }),
        historyEntry('bbbbbbbbbbbb', { agent: 'review' }),
      ],
      toolUseAgents: [toolUseAgent('simplifier'), toolUseAgent('review')],
    });

    expect(items.map((item) => item.label)).toContain('Chat with review');
    expect(items.map((item) => item.label)).not.toContain(
      'Chat with simplifier',
    );
  });

  it('lists team presets as runnable orchestration actions', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [readyPresetPlan()],
      history: [],
      toolUseAgents: [],
    });

    expect(items.find((item) => item.label === 'Team Physicist')).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({
          kind: 'preset',
          preset: 'physicist',
        }),
        description: 'ready; 2 tool-use agents; 1 workflow agent',
        disabled: false,
      }),
    );
  });

  it('does not promote built-in team members to fallback roots', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [
        presetPlan(
          {
            id: 'lean-project',
            name: 'Lean Project',
            workflowAgents: [],
            toolUseAgents: ['lean', 'leanSearch'],
          },
          {
            toolUseAgents: [toolUseAgent('lean')],
          },
        ),
      ],
      history: [],
      toolUseAgents: [],
    });

    expect(items.find((item) => item.label === 'Team Lean Project')).toEqual(
      expect.objectContaining({
        disabled: true,
        description: 'unavailable; no runnable team root; 1/2 tool-use agents',
        footerHints: [
          'Team setup: run texra multi-agent inspect <preset>.',
          'Relay teams may unlock more agents after texra login.',
        ],
      }),
    );
  });

  it('dedupes launcher footer hints from unavailable teams', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [
        presetPlan({ id: 'lean-project', name: 'Lean Project' }),
        presetPlan({ id: 'physicist', name: 'Physicist' }),
      ],
      history: [],
      toolUseAgents: [],
    });

    expect(orchestrationFooterHints(items)).toEqual([
      'Team setup: run texra multi-agent inspect <preset>.',
      'Relay teams may unlock more agents after texra login.',
    ]);
  });

  it('omits the launcher login hint after a remote team load attempt', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [presetPlan({ id: 'lean-project', name: 'Lean Project' })],
      history: [],
      toolUseAgents: [],
      includeMultiAgentLoginHint: false,
    });

    expect(orchestrationFooterHints(items)).toEqual([
      'Team setup: run texra multi-agent inspect <preset>.',
    ]);
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

  it('disables model-dependent launcher rows when no personal model can run', () => {
    const view = orchestrationModelAccessView(
      buildCliOrchestrationItems({
        presetPlans: [readyPresetPlan()],
        history: [
          historyEntry('aaaaaaaaaaaa', {
            agent: 'review',
            status: CLI_HISTORY_RESUMABLE_STATUS,
          }),
        ],
        toolUseAgents: [toolUseAgent('review')],
      }),
      [modelAccess('deepseekT', 'provider-key', false)],
      'personal',
    );

    const disabledLabels = view.items
      .filter((item) => item.disabled)
      .map((item) => item.label);
    expect(disabledLabels).toEqual([
      'New chat',
      'Chat with review',
      'Team Physicist',
    ]);
    expect(
      view.items.find((item) => item.label === 'Resume aaaaaaaaaaaa'),
    ).not.toHaveProperty('disabled');
    expect(view.items.at(-1)).toMatchObject({ label: 'Help' });
    expect(view.items[0]?.description).toBe(
      'No personal API-key models are runnable',
    );
    expect(view.modelItems).toEqual([]);
  });

  it('preserves unavailable team descriptions when model access is also blocked', () => {
    const view = orchestrationModelAccessView(
      buildCliOrchestrationItems({
        presetPlans: [
          presetPlan(
            {
              id: 'lean-project',
              name: 'Lean Project',
              workflowAgents: [],
              toolUseAgents: ['lean', 'leanSearch'],
            },
            {
              toolUseAgents: [toolUseAgent('lean')],
            },
          ),
        ],
        history: [],
        toolUseAgents: [],
      }),
      [modelAccess('deepseekT', 'provider-key', false)],
      'personal',
    );

    expect(view.items[0]).toMatchObject({
      label: 'New chat',
      disabled: true,
      description: 'No personal API-key models are runnable',
    });
    expect(
      view.items.find((item) => item.label === 'Team Lean Project'),
    ).toMatchObject({
      disabled: true,
      description: 'unavailable; no runnable team root; 1/2 tool-use agents',
    });
  });

  it('scopes startup model choices to the active API mode', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [readyPresetPlan()],
      history: [historyEntry('aaaaaaaaaaaa', { agent: 'review' })],
      toolUseAgents: [toolUseAgent('review')],
    });
    const models = [
      modelAccess('sonnet46T', 'included-access', true, 'included'),
      modelAccess('deepseekT', 'provider-key', true, 'api key set'),
      modelAccess('gemini31p', 'missing-key', false),
    ];

    const relayView = orchestrationModelAccessView(items, models, 'included');
    const personalView = orchestrationModelAccessView(
      items,
      models,
      'personal',
    );

    expect(relayView.modelItems.map((item) => item.value)).toEqual([
      'sonnet46T',
    ]);
    expect(relayView.modelItems.map((item) => item.description)).toEqual([
      'relay: included',
    ]);
    expect(personalView.modelItems.map((item) => item.value)).toEqual([
      'deepseekT',
    ]);
    expect(personalView.modelItems.map((item) => item.description)).toEqual([
      'api: api key set',
    ]);
  });

  it('keeps launcher rows active when model registry state is unknown', () => {
    const view = orchestrationModelAccessView(
      buildCliOrchestrationItems({
        presetPlans: [readyPresetPlan()],
        history: [],
        toolUseAgents: [],
      }),
      [],
      'personal',
    );

    expect(view.items.some((item) => item.disabled)).toBe(false);
  });

  it('keeps launcher rows active when a hidden runtime default can launch', () => {
    const view = orchestrationModelAccessView(
      buildCliOrchestrationItems({
        presetPlans: [readyPresetPlan()],
        history: [],
        toolUseAgents: [],
      }),
      [modelAccess('deepseekT', 'provider-key', false)],
      'personal',
      { allowDefaultModelLaunch: true },
    );

    expect(view.items.some((item) => item.disabled)).toBe(false);
    expect(view.modelItems).toEqual([]);
  });

  it('uses relay-specific disabled text when included access needs login', () => {
    const view = orchestrationModelAccessView(
      buildCliOrchestrationItems({
        presetPlans: [],
        history: [],
        toolUseAgents: [],
      }),
      [modelAccess('sonnet46T', 'included-login-required', false)],
      'included',
    );

    expect(view.items[0]).toMatchObject({
      disabled: true,
      description: 'Sign in with texra login for included relay models',
    });
  });
});
