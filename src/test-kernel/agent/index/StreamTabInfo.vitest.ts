import { describe, expect, it } from 'vitest';

import { buildStreamTabInfo } from '@agent/index';
import { AgentCategory } from '@shared/schemas';
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
});
