import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  orchestrationBlockRowCost,
  orchestrationFooterHints,
  orchestrationKeyHints,
  orchestrationLauncherLayout,
  orchestrationPreviousStep,
  orchestrationWrappedLineRows,
} from '@cli/orchestration/runOrchestrationTui';
import {
  buildCliAccountItems,
  buildCliAgentItems,
  buildCliOrchestrationItems,
  buildCliResumeItems,
  buildCliTeamItems,
  orchestrationModelAccessView,
} from '@cli/runtime/orchestration';
import { buildCliModelAccessItems } from '@cli/runtime/modelAccessRoute';

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
import type { ExecutionId, ModelAccessStatus } from '@shared/schemas';

function modelAccessStatus(
  overrides: {
    apiMode?: ModelAccessStatus['apiMode'];
    chatGpt?: Partial<ModelAccessStatus['chatGpt']>;
    kimiCode?: Partial<ModelAccessStatus['kimiCode']>;
    personalApiKeySet?: boolean;
    texraSignedIn?: boolean;
  } = {},
): ModelAccessStatus {
  return {
    apiMode: overrides.apiMode ?? 'personal',
    chatGpt: {
      signedIn: false,
      email: null,
      accountId: null,
      preferSubscription: false,
      subscriptionToolUseOnly: false,
      ...overrides.chatGpt,
    },
    kimiCode: {
      keySet: false,
      preferred: false,
      ...overrides.kimiCode,
    },
    personalApiKeySet: overrides.personalApiKeySet ?? false,
    texraSignedIn: overrides.texraSignedIn,
  };
}

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
    icon: 'symbol-operator',
    workflowAgents: ['criticize'],
    toolUseAgents: ['orchestrator', 'review'],
    texraHostedAgents: ['orchestrator'],
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

const ORCHESTRATION_TEST_HEADER_LINES = [
  'TeXRA v0.0.0-test',
  'Start a session or configure model access.',
] as const;

describe('CLI orchestration items', () => {
  it('returns from model selection to the agent or team picker that opened it', () => {
    const action = { kind: 'chat' as const, agent: 'assistant' };

    expect(
      orchestrationPreviousStep({ kind: 'model', action, backTo: 'agent' }),
    ).toEqual({ kind: 'agent' });
    expect(
      orchestrationPreviousStep({ kind: 'model', action, backTo: 'team' }),
    ).toEqual({ kind: 'team' });
    expect(
      orchestrationPreviousStep({ kind: 'model', action, backTo: 'launcher' }),
    ).toEqual({ kind: 'launcher' });
  });

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

  it('budgets wrapped launcher status rows instead of assuming one row per line', () => {
    const accountHint =
      'actions: choose Model access below; `texra login --select-account` changes account';

    expect(orchestrationWrappedLineRows(accountHint, 52)).toBeGreaterThan(1);
    expect(orchestrationBlockRowCost([accountHint], 52)).toBe(
      1 + orchestrationWrappedLineRows(accountHint, 52),
    );
  });

  it('keeps compact launcher orientation before advisory footer text', () => {
    const layout = orchestrationLauncherLayout({
      rows: 10,
      columns: 80,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines: [],
      footerHints: [
        'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.',
        'Researcher Access sign-in may unlock more remote team agents.',
      ],
    });

    expect(layout).toEqual({
      statusLines: [],
      footerHints: [],
      maxVisibleItems: 3,
      showOverflow: true,
    });
  });

  it('keeps launcher status lines before advisory footer text', () => {
    const statusLines = ['auth: signed out'];
    const footerHints = [
      'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.',
    ];

    const layout = orchestrationLauncherLayout({
      rows: 13,
      columns: 80,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines,
      footerHints,
    });

    expect(layout).toEqual({
      statusLines,
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('budgets wrapped launcher header rows before growing the list', () => {
    const layout = orchestrationLauncherLayout({
      rows: 12,
      columns: 30,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines: [],
      footerHints: [],
    });

    expect(layout).toEqual({
      statusLines: [],
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('preserves the longest fitting status prefix before hiding all status lines', () => {
    const statusLines = [
      'mode: included TeXRA access',
      'auth: signed out',
      'actions: `texra login` unlocks included models',
    ];

    const layout = orchestrationLauncherLayout({
      rows: 14,
      columns: 80,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines,
      footerHints: [],
    });

    expect(layout).toEqual({
      statusLines: statusLines.slice(0, 2),
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('keeps compact signed-in auth after the API mode on short launchers', () => {
    const statusLines = [
      'api: included TeXRA access',
      'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 25% used, 75% remaining',
    ];

    const layout = orchestrationLauncherLayout({
      rows: 14,
      columns: 80,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines,
      footerHints: [],
    });

    expect(layout).toEqual({
      statusLines: [
        'api: included TeXRA access',
        'auth: signed in as researcher@example.com',
      ],
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('keeps footer hints when compact auth creates enough room', () => {
    const statusLines = [
      'api: included TeXRA access',
      'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 25% used, 75% remaining',
    ];
    const footerHints = ['Team settings are available from the launcher.'];

    const layout = orchestrationLauncherLayout({
      rows: 16,
      columns: 80,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines,
      footerHints,
    });

    expect(layout.statusLines).toEqual([
      'api: included TeXRA access',
      'auth: signed in as researcher@example.com',
    ]);
    expect(layout.footerHints).toEqual(footerHints);
    expect(layout.maxVisibleItems).toBe(4);
  });

  it('uses the compact auth fallback when the launcher is narrow', () => {
    const statusLines = [
      'api: personal API keys',
      'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 25% used, 75% remaining',
    ];

    const layout = orchestrationLauncherLayout({
      rows: 16,
      columns: 40,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines,
      footerHints: [],
    });

    expect(layout.statusLines).toEqual([
      'api: personal API keys',
      'auth: signed in as researcher@example.com',
    ]);
    expect(layout.maxVisibleItems).toBe(4);
  });

  it('keeps visible choices instead of overflow-only output on tiny row budgets', () => {
    const layout = orchestrationLauncherLayout({
      rows: 7,
      columns: 80,
      itemCount: 7,
      headerLines: ORCHESTRATION_TEST_HEADER_LINES,
      statusLines: [],
      footerHints: [],
    });

    expect(layout).toEqual({
      statusLines: [],
      footerHints: [],
      maxVisibleItems: 2,
      showOverflow: false,
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

  it('keeps model access directly below new chat and presents every access route', () => {
    const status = modelAccessStatus({
      apiMode: 'included',
      chatGpt: { signedIn: true, email: 'researcher@example.com' },
    });
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [],
      toolUseAgents: [],
      modelAccess: status,
    });

    expect(items[1]).toEqual({
      label: 'Model access',
      description: 'Included TeXRA access · TeXRA account',
      value: { kind: 'configure-model-access' },
    });
    expect(buildCliModelAccessItems(status)).toEqual([
      {
        value: 'chatgpt',
        label: 'ChatGPT subscription preference',
        description: 'Off · researcher@example.com',
      },
      {
        value: 'kimi-code',
        label: 'Kimi Code subscription preference',
        description: 'Add a key with /key (kimi.com/code/console)',
      },
      {
        value: 'included',
        label: 'Included TeXRA access',
        description: 'TeXRA account',
      },
      {
        value: 'personal',
        label: 'Personal API keys',
        description: 'No provider API keys configured',
      },
    ]);
  });

  it('presents agent skills as an independent launcher switch', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [],
      toolUseAgents: [],
      agentSkillsEnabled: true,
    });

    expect(items.find((item) => item.label === 'Agent skills')).toEqual({
      label: 'Agent skills',
      description: 'On · TeXRA and imported skills available to agents',
      value: { kind: 'set-agent-skills', enabled: false },
    });
  });

  it('describes the Kimi Code route by key state and activity', () => {
    expect(
      buildCliModelAccessItems(
        modelAccessStatus({
          apiMode: 'personal',
          kimiCode: { keySet: true },
          personalApiKeySet: true,
        }),
      )[1],
    ).toEqual({
      value: 'kimi-code',
      label: 'Kimi Code subscription preference',
      description: 'Off · key configured',
    });
    expect(
      buildCliModelAccessItems(
        modelAccessStatus({
          apiMode: 'personal',
          kimiCode: { keySet: true, preferred: true },
          personalApiKeySet: true,
        }),
      )[1].description,
    ).toBe('On · key configured');

    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [],
      toolUseAgents: [],
      modelAccess: modelAccessStatus({
        apiMode: 'personal',
        kimiCode: { keySet: true, preferred: true },
        personalApiKeySet: true,
      }),
    });
    expect(items[1]).toEqual({
      label: 'Model access',
      description:
        'Kimi Code · fallback: Personal API keys (Provider API key configured)',
      value: { kind: 'configure-model-access' },
    });

    const includedItems = buildCliOrchestrationItems({
      presetPlans: [],
      history: [],
      toolUseAgents: [],
      modelAccess: modelAccessStatus({
        apiMode: 'included',
        texraSignedIn: true,
        kimiCode: { keySet: true, preferred: true },
      }),
    });
    expect(includedItems[1]?.description).toBe(
      'Kimi Code · fallback: Included TeXRA access (TeXRA account)',
    );
  });

  it('offers account management as one startup row with provider actions', () => {
    const account = {
      texraSignedIn: true,
      texraAccountLabel: 'researcher@example.com',
      chatGptSignedIn: false,
    };
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [],
      toolUseAgents: [],
      account,
    });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Account',
      'Settings',
      'Help',
    ]);
    expect(buildCliAccountItems(account)).toEqual([
      expect.objectContaining({
        value: { kind: 'account', provider: 'chatgpt', operation: 'sign-in' },
      }),
      expect.objectContaining({
        label: 'Log out of TeXRA',
        description: '',
        value: { kind: 'account', provider: 'texra', operation: 'sign-out' },
      }),
    ]);
  });

  it('offers both sign-in paths when no account is present', () => {
    const account = {
      texraSignedIn: false,
      chatGptSignedIn: false,
    };

    expect(buildCliAccountItems(account)).toEqual([
      expect.objectContaining({
        value: { kind: 'account', provider: 'chatgpt', operation: 'sign-in' },
      }),
      expect.objectContaining({
        label: 'Log in to TeXRA',
        description: '',
        value: { kind: 'account', provider: 'texra', operation: 'sign-in' },
      }),
    ]);
    expect(
      buildCliModelAccessItems(
        modelAccessStatus({
          apiMode: 'personal',
          texraSignedIn: false,
        }),
      ).find((item) => item.value === 'included')?.description,
    ).toBe('TeXRA account sign-in required');
  });

  it('does not offer to sign out an environment-managed relay token', () => {
    const items = buildCliAccountItems({
      texraSignedIn: true,
      texraCredentialSource: 'relayToken',
      chatGptSignedIn: false,
    });

    expect(items[1]).toMatchObject({
      label: 'Log out of TeXRA',
      value: { kind: 'account', provider: 'texra', operation: 'sign-out' },
      disabled: true,
      description: 'Managed by the TEXRA_RELAY_TOKEN environment variable',
    });
  });

  it('places Team before Resume and Agent when all three are available', () => {
    const history = [
      historyEntry('aaaaaaaaaaaa', {
        agent: 'review',
        status: CLI_HISTORY_RESUMABLE_STATUS,
      }),
      historyEntry('bbbbbbbbbbbb', {
        agent: 'orchestrator',
        status: CLI_HISTORY_RESUMABLE_STATUS,
      }),
    ];
    const items = buildCliOrchestrationItems({
      presetPlans: [readyPresetPlan()],
      history,
      toolUseAgents: [
        toolUseAgent('assistant'),
        toolUseAgent('review'),
        toolUseAgent('orchestrator'),
      ],
    });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Team',
      'Resume',
      'Agent',
      'Settings',
      'Help',
    ]);
    expect(items[2]?.description).toBe('2 resumable sessions');
    expect(buildCliResumeItems(history).map((item) => item.label)).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb',
    ]);
  });

  it('hides delegated child executions from the resume menu', () => {
    const items = buildCliOrchestrationItems({
      presetPlans: [],
      history: [
        historyEntry('aaaaaaaaaaaa', {
          agent: 'search',
          status: CLI_HISTORY_RESUMABLE_STATUS,
          parentExecutionId: 'root-session' as ExecutionId,
        }),
        historyEntry('bbbbbbbbbbbb', {
          agent: 'review',
          status: CLI_HISTORY_RESUMABLE_STATUS,
          parentExecutionId: 'root-session' as ExecutionId,
        }),
        historyEntry('cccccccccccc', {
          agent: 'orchestrator',
          status: CLI_HISTORY_RESUMABLE_STATUS,
        }),
      ],
      toolUseAgents: [
        toolUseAgent('assistant'),
        toolUseAgent('search'),
        toolUseAgent('review'),
        toolUseAgent('orchestrator'),
      ],
    });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Resume',
      'Agent',
      'Settings',
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
      toolUseAgents: [
        toolUseAgent('assistant'),
        toolUseAgent('review'),
        toolUseAgent('orchestrator'),
      ],
    });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Agent',
      'Settings',
      'Help',
    ]);
  });

  it('uses the input file name in resume launcher rows when present', () => {
    const items = buildCliResumeItems([
      historyEntry('aaaaaaaaaaaa', {
        agent: 'review',
        status: CLI_HISTORY_RESUMABLE_STATUS,
        inputBasename: 'paper.tex',
      }),
    ]);

    expect(items[0]?.description).toBe(
      '2026-05-21T00:00:00Z; review; resumable; paper.tex',
    );
  });

  it('uses the history description for resume launcher rows without input files', () => {
    const items = buildCliResumeItems([
      historyEntry('aaaaaaaaaaaa', {
        agent: 'assistant',
        status: CLI_HISTORY_RESUMABLE_STATUS,
        inputBasename: '-',
        description: 'Sketching inductive Lean proof of Nat.add_comm.',
      }),
    ]);

    expect(items[0]?.description).toBe(
      '2026-05-21T00:00:00Z; assistant; resumable; Sketching inductive Lean proof of Nat.add_comm.',
    );
  });

  it('orders assistant and orchestrator first in the single-agent menu', () => {
    const items = buildCliAgentItems([
      toolUseAgent('review'),
      toolUseAgent('orchestrator'),
      toolUseAgent('assistant'),
      toolUseAgent('research'),
      toolUseAgent('simplifier'),
    ]);

    expect(items.map((item) => item.label)).toEqual([
      'assistant',
      'orchestrator',
      'research',
      'review',
    ]);
    expect(items[0]?.value).toEqual({
      kind: 'chat',
      agent: 'builtInToolUse:assistant',
    });
  });

  it('lists team presets as runnable orchestration actions', () => {
    const items = buildCliTeamItems([readyPresetPlan()], {});

    expect(items.find((item) => item.label === 'Team physicist')).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({
          kind: 'preset',
          preset: 'physicist',
        }),
        description: 'ready; 1 workflow; 2 tools; Physicist',
        disabled: false,
      }),
    );
  });

  it('disables team presets when the approval policy blocks delegation', () => {
    const launcherItems = buildCliOrchestrationItems({
      presetPlans: [readyPresetPlan()],
      history: [],
      toolUseAgents: [],
      presetLaunchBlockReason: 'delegation-denied',
    });
    const teamItems = buildCliTeamItems([readyPresetPlan()], {
      launchBlockReason: 'delegation-denied',
    });

    expect(launcherItems.find((item) => item.label === 'Team')).toEqual(
      expect.objectContaining({
        description: 'Delegation blocked by "never"; use ask or yolo',
        disabled: true,
      }),
    );
    expect(teamItems.find((item) => item.label === 'Team physicist')).toEqual(
      expect.objectContaining({
        description: 'Delegation blocked by "never"; use ask or yolo',
        disabled: true,
      }),
    );
  });

  it('lists every team preset so the user can switch between teams', () => {
    const plans = [
      readyPresetPlan({ id: 'lean-project', name: 'Lean Project' }),
      readyPresetPlan({ id: 'physicist', name: 'Physicist' }),
      readyPresetPlan({ id: 'mathematician', name: 'Mathematician' }),
    ];
    const items = buildCliOrchestrationItems({
      presetPlans: plans,
      history: [],
      toolUseAgents: [],
    });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Team',
      'Settings',
      'Help',
    ]);
    expect(buildCliTeamItems(plans, {}).map((item) => item.label)).toEqual([
      'Team lean-project',
      'Team physicist',
      'Team mathematician',
    ]);
  });

  it('does not promote built-in team members to fallback roots', () => {
    const items = buildCliTeamItems(
      [
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
      { includeLoginHint: true },
    );

    expect(items.find((item) => item.label === 'Team lean-project')).toEqual(
      expect.objectContaining({
        disabled: true,
        description: 'unavailable; no team root; 1/2 tools; Lean Project',
        footerHints: [
          'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.',
          'Researcher Access sign-in may unlock more remote team agents.',
        ],
      }),
    );
  });

  it('keeps sign-in-remediable teams actionable while signed out', () => {
    const items = buildCliTeamItems(
      [presetPlan({ id: 'physicist', name: 'Physicist' })],
      { includeLoginHint: true, remoteAgentCatalogAvailable: false },
    );

    expect(items[0]).toMatchObject({
      value: { kind: 'preset', preset: 'physicist' },
      disabled: false,
    });
  });

  it('dedupes launcher footer hints from unavailable teams', () => {
    const items = buildCliTeamItems(
      [
        presetPlan({ id: 'lean-project', name: 'Lean Project' }),
        presetPlan({ id: 'physicist', name: 'Physicist' }),
      ],
      { includeLoginHint: true },
    );

    expect(orchestrationFooterHints(items)).toEqual([
      'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.',
      'Researcher Access sign-in may unlock more remote team agents.',
    ]);
  });

  it('omits the launcher login hint after a remote team load attempt', () => {
    const items = buildCliTeamItems(
      [presetPlan({ id: 'lean-project', name: 'Lean Project' })],
      { includeLoginHint: false },
    );

    expect(orchestrationFooterHints(items)).toEqual([
      'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.',
    ]);
  });

  it('keeps team launch actions keyed by preset id only', () => {
    const items = buildCliTeamItems(
      [presetPlan({ id: 'physicist', name: 'Physicist' })],
      {},
    );

    expect(
      items.find((item) => item.label === 'Team physicist')?.value,
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
        toolUseAgents: [toolUseAgent('assistant'), toolUseAgent('review')],
      }),
      [modelAccess('deepseekT', 'provider-key', false)],
      'personal',
    );

    const disabledLabels = view.items
      .filter((item) => item.disabled)
      .map((item) => item.label);
    expect(disabledLabels).toEqual(['New chat']);
    expect(
      view.items.find((item) => item.label === 'Resume'),
    ).not.toHaveProperty('disabled');
    expect(view.items.at(-1)).toMatchObject({ label: 'Help' });
    expect(view.items[0]?.description).toBe(
      'No personal API-key models are runnable',
    );
    expect(view.modelItems).toEqual([]);
  });

  it('preserves unavailable team descriptions when model access is also blocked', () => {
    const view = orchestrationModelAccessView(
      buildCliTeamItems(
        [
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
        {},
      ),
      [modelAccess('deepseekT', 'provider-key', false)],
      'personal',
    );

    expect(
      view.items.find((item) => item.label === 'Team lean-project'),
    ).toMatchObject({
      disabled: true,
      description: 'unavailable; no team root; 1/2 tools; Lean Project',
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
      'included: available',
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
      description: 'Sign in with texra login for included TeXRA models',
    });
  });
});
