import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { buildInitialChatAgentConfig } from '@cli/chat/tui/runChatTui';

describe('CLI chat run config', () => {
  it('tags preset-launched team chats with the multi-agent preset id', () => {
    expect(
      buildInitialChatAgentConfig({
        agent: 'orchestrator',
        model: 'deepseekT',
        instruction: 'prove the bounded case',
        workingDirectory: '/tmp/project',
        cliMultiAgentPresetId: 'physicist',
      }),
    ).toMatchObject({
      agent: 'orchestrator',
      model: 'deepseekT',
      instruction: 'prove the bounded case',
      workingDirectory: '/tmp/project',
      agentCategory: AgentCategory.ToolUse,
      cliMultiAgentPresetId: 'physicist',
    });
  });

  it('does not tag ordinary chats as multi-agent preset runs', () => {
    expect(
      buildInitialChatAgentConfig({
        agent: 'chat',
        model: 'deepseekT',
        instruction: 'hello',
        workingDirectory: '/tmp/project',
      }),
    ).not.toHaveProperty('cliMultiAgentPresetId');
  });
});
