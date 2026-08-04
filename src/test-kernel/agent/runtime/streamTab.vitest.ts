// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { getStreamTabId } from '@agent/runtime/streamTab';
import type { ExecutionId } from '@shared/schemas';

describe('getStreamTabId', () => {
  const EXEC_ID = 'abcdef012345' as ExecutionId;

  it('builds an opaque identifier from agent name and executionId', () => {
    const id = getStreamTabId('polish', { executionId: EXEC_ID });
    assert.equal(id, `polish#${EXEC_ID}`);
  });

  it('strips the source prefix from the agent name', () => {
    // Only valid AgentSource prefixes are stripped ('builtInWorkflow',
    // 'builtInToolUse', 'custom', 'remote'); unknown prefixes are kept.
    const id = getStreamTabId('builtInWorkflow:polish', {
      executionId: EXEC_ID,
    });
    assert.equal(id, `polish#${EXEC_ID}`);
  });

  it('gives each execution a unique tab id', () => {
    const id1 = getStreamTabId('polish', {
      executionId: 'aaaaaaaaaaaa' as ExecutionId,
    });
    const id2 = getStreamTabId('polish', {
      executionId: 'bbbbbbbbbbbb' as ExecutionId,
    });
    assert.notEqual(id1, id2);
  });
});
