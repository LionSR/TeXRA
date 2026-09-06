import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAgentForLaunch, type AgentEntry } from '@agent/index';
import type { ResolvedAgent } from '@agent/index/agentEntry';
import {
  applyInitialCliAgentSelection,
  chatToolUseAgentUsageError,
} from '@cli/chat/tui/commands/handlers/agentModelCommands';
import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
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
