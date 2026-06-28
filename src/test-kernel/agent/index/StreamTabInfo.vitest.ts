import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@shared/schemas';
import { buildStreamTabInfo } from '@shared/progressView/backend/streamTabInfo';
import { isProcessAgent } from '@shared/streams/agentKind';

describe('buildStreamTabInfo', () => {
  it('classifies stream-id-derived bash child streams as process agents', () => {
    const info = buildStreamTabInfo({
      streamId: 'bash@tool#exec:child-stream',
      hints: {
        agentCategory: AgentCategory.ToolUse,
      },
      creationTimestamp: 1,
    });

    expect(info.label).toBe('bash');
    expect(info.agent).toBe('bash');
    expect(isProcessAgent(info.agent)).toBe(true);
    expect(info.model).toBeUndefined();
  });

  it('uses the resolved remote hint without registry lookup', () => {
    const info = buildStreamTabInfo({
      streamId: 'remote-agent@run',
      config: {
        agent: 'remote-agent',
        agentCategory: AgentCategory.ToolUse,
        model: 'gpt-4.1',
      },
      hints: {
        isRemote: true,
      },
      creationTimestamp: 1,
    });

    expect(info.agent).toBe('remote-agent');
    expect(info.isRemote).toBe(true);
  });
});
