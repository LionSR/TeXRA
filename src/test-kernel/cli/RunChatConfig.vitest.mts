import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgent, type AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  applyInitialCliAgentSelection,
  chatToolUseAgentUsageError,
} from '@cli/chat/tui/commands/handlers/agentModelCommands';
import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import {
  restorePendingSkillActivations,
  takePendingSkillActivations,
} from '@cli/chat/tui/runChatTui';

vi.mock('@agent/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/index')>();
  return {
    ...actual,
    getAgent: vi.fn(),
  };
});

vi.mock('@cli/chat/tui/state/transcript', () => ({
  appendLocalAssistantTranscript: vi.fn(),
}));

const mockedGetAgent = vi.mocked(getAgent);

function registryAgent(category: AgentCategory): AgentEntry {
  return {
    name: category === AgentCategory.ToolUse ? 'assistant' : 'polish',
    source:
      category === AgentCategory.ToolUse ? 'builtInToolUse' : 'builtInWorkflow',
    path: '/tmp/agent.yaml',
    category,
  };
}

beforeEach(() => {
  mockedGetAgent.mockReset();
});

describe('CLI chat run config', () => {
  it('leaves team mode when the root agent is changed explicitly', () => {
    mockedGetAgent.mockReturnValue(registryAgent(AgentCategory.ToolUse));
    patchSessionMeta({
      teamName: 'Physicist',
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: {
        workflowAgentKeys: ['builtInWorkflow:polish'],
        toolUseAgentKeys: ['builtInToolUse:assistant'],
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
    mockedGetAgent.mockReturnValueOnce(registryAgent(AgentCategory.ToolUse));

    expect(chatToolUseAgentUsageError('assistant')).toBeUndefined();
    expect(mockedGetAgent).toHaveBeenCalledWith(
      'assistant',
      AgentCategory.ToolUse,
    );
  });

  it('rejects missing root chat agents before a prompt is submitted', () => {
    mockedGetAgent.mockReturnValueOnce(undefined);

    expect(chatToolUseAgentUsageError('mathematician')).toContain(
      'Tool-use agent not found: mathematician.',
    );
  });

  it('rejects workflow agents as root chat agents', () => {
    mockedGetAgent.mockReturnValueOnce(registryAgent(AgentCategory.Workflow));

    expect(chatToolUseAgentUsageError('polish')).toContain(
      '`texra chat` only handles tool-use agents',
    );
  });
});
