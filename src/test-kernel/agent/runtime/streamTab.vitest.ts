// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { getStreamTabId } from '@agent/runtime/streamTab';
import type { ExecutionId } from '@shared/schemas';

describe('getStreamTabId', () => {
  const EXEC_ID = 'abcdef012345' as ExecutionId;

  it('builds an identifier from agent, model, and executionId', () => {
    const id = getStreamTabId('polish', 'sonnet', { executionId: EXEC_ID });
    assert.equal(id, `polish@sonnet#${EXEC_ID}`);
  });

  it('strips the source prefix from the agent name', () => {
    // Only valid AgentSource prefixes are stripped ('builtInWorkflow',
    // 'builtInToolUse', 'custom', 'remote'); unknown prefixes are kept.
    const id = getStreamTabId('builtInWorkflow:polish', 'sonnet', {
      executionId: EXEC_ID,
    });
    assert.equal(id, `polish@sonnet#${EXEC_ID}`);
  });

});
