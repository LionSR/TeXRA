import { describe, expect, it } from 'vitest';

import { getStreamTabId } from '@agent/runtime/streamTab';
import type { ExecutionId } from '@shared/schemas';

describe('getStreamTabId', () => {
  const EXEC_ID = 'abcdef012345' as ExecutionId;

  it.each([
    'polish',
    // Only valid AgentSource prefixes are stripped ('builtInWorkflow',
    // 'builtInToolUse', 'custom', 'remote'); unknown prefixes are kept.
    'builtInWorkflow:polish',
  ])('builds the tab id `polish#<executionId>` from `%s`', (agent) => {
    expect(getStreamTabId(agent, { executionId: EXEC_ID })).toBe(
      `polish#${EXEC_ID}`,
    );
  });

  it('gives each execution a unique tab id', () => {
    expect(
      getStreamTabId('polish', { executionId: 'aaaaaaaaaaaa' as ExecutionId }),
    ).toBe('polish#aaaaaaaaaaaa');
    expect(
      getStreamTabId('polish', { executionId: 'bbbbbbbbbbbb' as ExecutionId }),
    ).toBe('polish#bbbbbbbbbbbb');
  });
});
