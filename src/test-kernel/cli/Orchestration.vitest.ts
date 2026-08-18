import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '@agent/index';
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
  type BuildCliOrchestrationItemsInput,
  type CliAccountStatus,
  type CliOrchestrationItem,
} from '@cli/runtime/orchestration';
import {
  buildCliModelAccessItems,
  type CliModelAccessStatus,
} from '@cli/runtime/modelAccessRoute';

import {
  CLI_HISTORY_RESUMABLE_STATUS,
  type CliHistoryEntry,
} from '@cli/runtime/history';
import type { CliModelAccess } from '@cli/runtime/modelAccess';
import {
  type CliMultiAgentPreset,
  type CliMultiAgentPresetRunPlan,
} from '@cli/runtime/multiAgentPresets';
import { planTeamRun } from '@common/teams/TeamPlan';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';

function codingPlans(
  kimiPreferred = false,
  kimiKeySet = false,
  glmPreferred = false,
  glmKeySet = false,
): CliModelAccessStatus['codingPlans'] {
  return {
    kimiCode: { preferred: kimiPreferred, keySet: kimiKeySet },
    glmCodingPlan: { preferred: glmPreferred, keySet: glmKeySet },
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
    icon: 'cube',
    agents: {
      workflow: ['criticize'],
      toolUse: ['orchestrator', 'review'],
    },
    texraHostedAgents: ['orchestrator'],
    source: 'built-in',
    ...overrides,
  };
}

function presetPlan(
  overrides: Partial<CliMultiAgentPreset>,
  agents: {
    readonly workflow?: readonly AgentEntry[];
    readonly toolUse?: readonly AgentEntry[];
  } = {},
): CliMultiAgentPresetRunPlan {
  return planTeamRun(preset(overrides), {
    agents: { workflow: agents.workflow ?? [], toolUse: agents.toolUse ?? [] },
  });
}

function readyPresetPlan(
  overrides: Partial<CliMultiAgentPreset> = {},
): CliMultiAgentPresetRunPlan {
  return presetPlan(
    { id: 'physicist', name: 'Physicist', ...overrides },
    {
      workflow: [workflowAgent('criticize')],
      toolUse: [
        toolUseAgent('orchestrator', ['delegate_agent']),
        toolUseAgent('review'),
      ],
    },
  );
}

function leanProjectPlan(): CliMultiAgentPresetRunPlan {
  return presetPlan(
    {
      id: 'lean-project',
      name: 'Lean Project',
      agents: { workflow: [], toolUse: ['lean', 'leanSearch'] },
    },
    { toolUse: [toolUseAgent('lean')] },
  );
}

function orchestrationItems(
  overrides: Partial<BuildCliOrchestrationItemsInput> = {},
): CliOrchestrationItem[] {
  return buildCliOrchestrationItems({
    presetPlans: [],
    history: [],
    toolUseAgents: [],
    ...overrides,
  });
}

function accountDescription(account: CliAccountStatus): string | undefined {
  return orchestrationItems({ account }).find(
    (item) => item.label === 'Account',
  )?.description;
}

function kimiCodePreferenceItem(
  access: CliModelAccessStatus,
): ReturnType<typeof buildCliModelAccessItems>[number] | undefined {
  return buildCliModelAccessItems({ kind: 'loaded', access }).find(
    (item) =>
      item.value.kind === 'subscription-preference' &&
      item.value.provider === 'kimi-code',
  );
}

const SIGNED_IN_AUTH_STATUS =
  'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 25% used, 75% remaining';

const ORCHESTRATION_TEST_HEADER_LINES = [
  'TeXRA v0.0.0-test',
  'Start a session or configure model access.',
] as const;

type LauncherLayoutInput = Parameters<typeof orchestrationLauncherLayout>[0];

/** Lay out the seven-item launcher under the test header, so each case only
 *  states the row budget and the status/footer text it is about. */
function launcherLayout(
  overrides: Partial<LauncherLayoutInput> & { readonly rows: number },
): ReturnType<typeof orchestrationLauncherLayout> {
  return orchestrationLauncherLayout({
    columns: 80,
    itemCount: 7,
    headerLines: ORCHESTRATION_TEST_HEADER_LINES,
    statusLines: [],
    footerHints: [],
    ...overrides,
  });
}

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
    const hints = orchestrationKeyHints();

    expect(hints).toContainEqual({ key: 'Esc', action: 'exit' });
    expect(hints).not.toContainEqual({ key: 'q/Esc', action: 'exit' });
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
    const layout = launcherLayout({
      rows: 10,
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

    const layout = launcherLayout({ rows: 13, statusLines, footerHints });

    expect(layout).toEqual({
      statusLines,
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('budgets wrapped launcher header rows before growing the list', () => {
    const layout = launcherLayout({ rows: 12, columns: 30 });

    expect(layout).toEqual({
      statusLines: [],
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('preserves the longest fitting status prefix before hiding all status lines', () => {
    const statusLines = [
      'mode: your own API keys',
      'auth: signed out',
      'actions: `texra login` unlocks remote agents',
    ];

    const layout = launcherLayout({ rows: 14, statusLines });

    expect(layout).toEqual({
      statusLines: statusLines.slice(0, 2),
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('keeps compact signed-in auth after the API mode on short launchers', () => {
    const statusLines = ['api: your own API keys', SIGNED_IN_AUTH_STATUS];

    const layout = launcherLayout({ rows: 14, statusLines });

    expect(layout).toEqual({
      statusLines: [
        'api: your own API keys',
        'auth: signed in as researcher@example.com',
      ],
      footerHints: [],
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });

  it('keeps footer hints when compact auth creates enough room', () => {
    const statusLines = ['api: your own API keys', SIGNED_IN_AUTH_STATUS];
    const footerHints = ['Team settings are available from the launcher.'];

    const layout = launcherLayout({ rows: 16, statusLines, footerHints });

    expect(layout.statusLines).toEqual([
      'api: your own API keys',
      'auth: signed in as researcher@example.com',
    ]);
    expect(layout.footerHints).toEqual(footerHints);
    expect(layout.maxVisibleItems).toBe(4);
  });

  it('uses the compact auth fallback when the launcher is narrow', () => {
    const statusLines = ['api: your own API keys', SIGNED_IN_AUTH_STATUS];

    const layout = launcherLayout({ rows: 16, columns: 40, statusLines });

    expect(layout.statusLines).toEqual([
      'api: your own API keys',
      'auth: signed in as researcher@example.com',
    ]);
    expect(layout.maxVisibleItems).toBe(4);
  });

  it('keeps visible choices instead of overflow-only output on tiny row budgets', () => {
    const layout = launcherLayout({ rows: 7 });

    expect(layout).toEqual({
      statusLines: [],
      footerHints: [],
      maxVisibleItems: 2,
      showOverflow: false,
    });
  });

  it('starts with new chat and keeps help as the final active item', () => {
    const items = orchestrationItems();

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
    const status = {
      preferences: {
        chatGpt: 'off',
        grok: 'off',
      } as const,
      codingPlans: codingPlans(),
      chatGptSignedIn: true,
      grokSignedIn: false,
      chatGptAccountLabel: 'researcher@example.com',
    };
    const items = orchestrationItems({ modelAccess: status });

    expect(items[1]).toEqual({
      label: 'Model access',
      description:
        'ChatGPT Off · Grok Off · Kimi Off · GLM Off · otherwise: your own API keys',
      value: { kind: 'configure-model-access' },
    });
    expect(
      buildCliModelAccessItems({ kind: 'loaded', access: status }),
    ).toEqual([
      {
        value: {
          kind: 'subscription-preference',
          provider: 'chatgpt',
          state: 'on',
        },
        label: 'Prefer ChatGPT subscription',
        description: 'Off · researcher@example.com',
      },
      {
        value: {
          kind: 'subscription-preference',
          provider: 'grok',
          state: 'on',
        },
        label: 'Prefer Grok subscription',
        description: 'Off · sign in required to enable',
      },
      {
        value: {
          kind: 'subscription-preference',
          provider: 'kimi-code',
          state: 'on',
        },
        label: 'Prefer Kimi Code subscription',
        description: 'Off · key required to enable',
      },
      {
        value: {
          kind: 'subscription-preference',
          provider: 'glm-code',
          state: 'on',
        },
        label: 'Prefer GLM Coding Plan',
        description: 'Off · key required to enable',
      },
    ]);
  });

  it('describes the Kimi Code route by key state and activity', () => {
    const kimiOff = kimiCodePreferenceItem({
      preferences: {
        chatGpt: 'off',
        grok: 'off',
      },
      codingPlans: codingPlans(false, true),
      chatGptSignedIn: false,
      grokSignedIn: false,
    });
    expect(kimiOff).toEqual({
      value: {
        kind: 'subscription-preference',
        provider: 'kimi-code',
        state: 'on',
      },
      label: 'Prefer Kimi Code subscription',
      description: 'Off · key configured',
    });

    const kimiOnAccess: CliModelAccessStatus = {
      preferences: {
        chatGpt: 'off',
        grok: 'off',
      },
      codingPlans: codingPlans(true, true),
      chatGptSignedIn: false,
      grokSignedIn: false,
    };
    expect(kimiCodePreferenceItem(kimiOnAccess)?.description).toBe(
      'On · key configured',
    );

    expect(orchestrationItems({ modelAccess: kimiOnAccess })[1]).toEqual({
      label: 'Model access',
      description:
        'ChatGPT Off · Grok Off · Kimi On · GLM Off · otherwise: your own API keys',
      value: { kind: 'configure-model-access' },
    });
  });

  it('shows subscription preferences independently', () => {
    const items = buildCliModelAccessItems({
      kind: 'loaded',
      access: {
        preferences: {
          chatGpt: 'on',
          grok: 'off',
        },
        codingPlans: codingPlans(true, true),
        chatGptSignedIn: true,
        grokSignedIn: false,
        chatGptAccountLabel: 'researcher@example.com',
      },
    });
    const byProvider = Object.fromEntries(
      items.flatMap((item) =>
        item.value.kind === 'subscription-preference'
          ? [[item.value.provider, item.description]]
          : [],
      ),
    );

    expect(byProvider).toEqual({
      chatgpt: 'On · researcher@example.com',
      grok: 'Off · sign in required to enable',
      'kimi-code': 'On · key configured',
      'glm-code': 'Off · key required to enable',
    });
  });

  it('offers account management as one startup row with provider actions', () => {
    const account = {
      texraSignedIn: true,
      texraAccountLabel: 'researcher@example.com',
      chatGptSignedIn: false,
      grokSignedIn: false,
    };
    const items = orchestrationItems({ account });

    expect(items.map((item) => item.label)).toEqual([
      'New chat',
      'Account',
      'Settings',
      'Help',
    ]);
    expect(items.find((item) => item.label === 'Account')?.description).toBe(
      'TeXRA · researcher@example.com',
    );
    expect(buildCliAccountItems(account)).toEqual([
      expect.objectContaining({
        value: { kind: 'account', provider: 'chatgpt', operation: 'sign-in' },
      }),
      expect.objectContaining({
        value: { kind: 'account', provider: 'grok', operation: 'sign-in' },
      }),
      expect.objectContaining({
        label: 'Log out of TeXRA',
        description: '',
        value: { kind: 'account', provider: 'texra', operation: 'sign-out' },
      }),
    ]);
  });

  it('summarizes multiple signed-in accounts with natural list grammar', () => {
    // #9719: "A and B and C" is awkward once Grok is a third account.
    expect(
      accountDescription({
        texraSignedIn: true,
        chatGptSignedIn: true,
        grokSignedIn: false,
      }),
    ).toBe('TeXRA and ChatGPT signed in');

    expect(
      accountDescription({
        texraSignedIn: true,
        chatGptSignedIn: true,
        grokSignedIn: true,
      }),
    ).toBe('TeXRA, ChatGPT, and Grok signed in');
  });

  it('offers both sign-in paths when no account is present', () => {
    const account = {
      texraSignedIn: false,
      chatGptSignedIn: false,
      grokSignedIn: false,
    };

    expect(buildCliAccountItems(account)).toEqual([
      expect.objectContaining({
        value: { kind: 'account', provider: 'chatgpt', operation: 'sign-in' },
      }),
      expect.objectContaining({
        value: { kind: 'account', provider: 'grok', operation: 'sign-in' },
      }),
      expect.objectContaining({
        label: 'Log in to TeXRA',
        description: '',
        value: { kind: 'account', provider: 'texra', operation: 'sign-in' },
      }),
    ]);
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
    const items = orchestrationItems({
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
    expect(items[2]?.description).toBe('2 sessions');
    expect(buildCliResumeItems(history).map((item) => item.label)).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb',
    ]);
  });

  it('does not list completed executions as resume launcher rows', () => {
    const items = orchestrationItems({
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
    const launcherItems = orchestrationItems({
      presetPlans: [readyPresetPlan()],
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
    const items = orchestrationItems({ presetPlans: plans });

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
    const items = buildCliTeamItems([leanProjectPlan()], {
      includeLoginHint: true,
    });

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
      orchestrationItems({
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
    );

    const disabledLabels = view.items
      .filter((item) => item.disabled)
      .map((item) => item.label);
    expect(disabledLabels).toEqual(['New chat']);
    expect(
      view.items.find((item) => item.label === 'Resume'),
    ).not.toHaveProperty('disabled');
    expect(view.items.at(-1)).toMatchObject({ label: 'Help' });
    expect(view.items[0]?.description).toBe('No models are available');
    expect(view.modelItems).toEqual([]);
  });

  it('preserves unavailable team descriptions when model access is also blocked', () => {
    const view = orchestrationModelAccessView(
      buildCliTeamItems([leanProjectPlan()], {}),
      [modelAccess('deepseekT', 'provider-key', false)],
    );

    expect(
      view.items.find((item) => item.label === 'Team lean-project'),
    ).toMatchObject({
      disabled: true,
      description: 'unavailable; no team root; 1/2 tools; Lean Project',
    });
  });

  it('names Kimi Code subscription access in model rows', () => {
    const kimi = modelAccess('kimi3', 'provider-key', true, 'api key set');
    const view = orchestrationModelAccessView(
      orchestrationItems({ presetPlans: [readyPresetPlan()] }),
      [
        {
          ...kimi,
          model: {
            ...kimi.model,
            provider: 'kimiCode',
            routeLabel: 'Via Kimi Code',
          },
        },
      ],
    );

    expect(view.modelItems).toMatchObject([
      {
        value: 'kimi3',
        description: 'api: Kimi Code subscription',
      },
    ]);
  });

  it('keeps launcher rows active when model registry state is unknown', () => {
    const view = orchestrationModelAccessView(
      orchestrationItems({ presetPlans: [readyPresetPlan()] }),
      [],
    );

    expect(view.items.some((item) => item.disabled)).toBe(false);
  });

  it('keeps launcher rows active when a hidden runtime default can launch', () => {
    const view = orchestrationModelAccessView(
      orchestrationItems({ presetPlans: [readyPresetPlan()] }),
      [modelAccess('deepseekT', 'provider-key', false)],
      { allowDefaultModelLaunch: true },
    );

    expect(view.items.some((item) => item.disabled)).toBe(false);
    expect(view.modelItems).toEqual([]);
  });
});
