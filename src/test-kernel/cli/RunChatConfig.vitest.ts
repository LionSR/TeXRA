import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveAgentForLaunch,
  type AgentEntry,
  type ResolvedAgent,
} from '@agent/index';
import {
  applyInitialCliAgentSelection,
  chatToolUseAgentUsageError,
} from '@cli/chat/tui/commands/handlers/agentModelCommands';
import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import {
  restorePendingSkillActivations,
  takePendingSkillActivations,
} from '@cli/chat/tui/chatSubmitDriver';
import { AgentCategory } from '@shared/schemas';

vi.mock('@agent/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/index')>();
  return {
    ...actual,
    resolveAgentForLaunch: vi.fn(),
  };
});

vi.mock('@cli/chat/tui/state/transcript', () => ({
  appendLocalAssistantTranscript: vi.fn(),
}));

const mockedResolveAgentForLaunch = vi.mocked(resolveAgentForLaunch);

function registryAgent(category: AgentCategory): AgentEntry {
  return {
    name: category === AgentCategory.ToolUse ? 'assistant' : 'polish',
    source:
      category === AgentCategory.ToolUse ? 'builtInToolUse' : 'builtInWorkflow',
    path: '/tmp/agent.yaml',
    category,
  };
}

function registryResolution(category: AgentCategory): ResolvedAgent {
  const entry = registryAgent(category);
  return { entry };
}

beforeEach(() => {
  mockedResolveAgentForLaunch.mockReset();
});

describe('CLI chat run config', () => {
  it('leaves team mode when the root agent is changed explicitly', () => {
    mockedResolveAgentForLaunch.mockReturnValue(
      registryResolution(AgentCategory.ToolUse),
    );
    patchSessionMeta({
      teamName: 'Physicist',
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: {
        workflow: ['builtInWorkflow:polish'],
        toolUse: ['builtInToolUse:assistant'],
      },
    });
    const context = {
      session: {
        runPromise: undefined,
        runCompleted: false,
        stopRequested: false,
      },
    } as Parameters<typeof applyInitialCliAgentSelection>[1];

    applyInitialCliAgentSelection('assistant', context);

    expect(sessionMeta.get()).toMatchObject({ agent: 'assistant' });
    expect(sessionMeta.get().teamName).toBeUndefined();
    expect(sessionMeta.get().cliMultiAgentPresetId).toBeUndefined();
    expect(sessionMeta.get().delegationAgentScope).toBeUndefined();
  });

  it('reserves pending skill activations for only one prepared message', () => {
    const pending = new Map([
      ['proof-audit', '<skill_activation>proof</skill_activation>'],
    ]);

    const first = takePendingSkillActivations(pending, 'first request');
    const second = takePendingSkillActivations(pending, 'second request');

    expect(first).toMatchObject({
      displayInstruction: 'first request',
      reservedSkillActivations: [
        {
          name: 'proof-audit',
          activationPrompt: '<skill_activation>proof</skill_activation>',
        },
      ],
    });
    expect(first.instruction).toContain(
      '<skill_activation>proof</skill_activation>',
    );
    expect(first.instruction).toContain(
      '<user_request>\nfirst request\n</user_request>',
    );
    expect(second).toEqual({
      instruction: 'second request',
      reservedSkillActivations: [],
    });
  });

  it('restores reserved skill activations without replacing newer selections', () => {
    const pending = new Map([
      ['proof-audit', '<skill_activation>old</skill_activation>'],
    ]);
    const reserved = takePendingSkillActivations(
      pending,
      'first request',
    ).reservedSkillActivations;

    restorePendingSkillActivations(pending, reserved);
    expect(pending.get('proof-audit')).toBe(
      '<skill_activation>old</skill_activation>',
    );

    pending.clear();
    pending.set('proof-audit', '<skill_activation>new</skill_activation>');
    restorePendingSkillActivations(pending, reserved);

    expect(pending.get('proof-audit')).toBe(
      '<skill_activation>new</skill_activation>',
    );
  });

  it('escapes user request text inside skill activation wrappers', () => {
    const pending = new Map([
      ['proof-audit', '<skill_activation>proof</skill_activation>'],
    ]);

    const prepared = takePendingSkillActivations(pending, 'compare A < B & C');

    expect(prepared.displayInstruction).toBe('compare A < B & C');
    expect(prepared.instruction).toContain(
      '<user_request>\ncompare A &lt; B &amp; C\n</user_request>',
    );
  });

  it('accepts valid tool-use root chat agents', () => {
    mockedResolveAgentForLaunch.mockReturnValueOnce(
      registryResolution(AgentCategory.ToolUse),
    );

    expect(chatToolUseAgentUsageError('assistant')).toBeUndefined();
    expect(mockedResolveAgentForLaunch).toHaveBeenCalledWith(
      AgentCategory.ToolUse,
      'assistant',
      undefined,
    );
  });

  it('rejects missing root chat agents before a prompt is submitted', () => {
    mockedResolveAgentForLaunch.mockReturnValue(undefined);

    expect(chatToolUseAgentUsageError('mathematician')).toContain(
      'Tool-use agent not found: mathematician.',
    );
  });

  it('rejects workflow agents as root chat agents', () => {
    mockedResolveAgentForLaunch.mockImplementation((category) =>
      category === AgentCategory.Workflow
        ? registryResolution(AgentCategory.Workflow)
        : undefined,
    );

    expect(chatToolUseAgentUsageError('polish')).toContain(
      '`texra chat` only handles tool-use agents',
    );
  });
});
