import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@shared/schemas';
import { buildStreamTabInfo } from '@shared/progressView/backend/streamTabInfo';

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
    expect(info.kind).toBe('process');
  });
});
