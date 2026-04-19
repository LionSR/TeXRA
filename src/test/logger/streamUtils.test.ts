// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { getStreamTabId } from '@/logger/streamUtils';

describe('getStreamTabId', () => {
  const EXEC_ID = 'abcdef012345' as const;

  it('builds an identifier from agent, model, and executionId', () => {
    const id = getStreamTabId('polish', 'sonnet', { executionId: EXEC_ID });
    assert.equal(id, `polish@sonnet#${EXEC_ID}`);
  });

  it('strips the source prefix from the agent name', () => {
    const id = getStreamTabId('builtin:polish', 'sonnet', {
      executionId: EXEC_ID,
    });
    assert.equal(id, `polish@sonnet#${EXEC_ID}`);
  });

  it('gives each execution a unique tab id', () => {
    const id1 = getStreamTabId('polish', 'sonnet', {
      executionId: 'aaaaaaaaaaaa',
    });
    const id2 = getStreamTabId('polish', 'sonnet', {
      executionId: 'bbbbbbbbbbbb',
    });
    assert.notEqual(id1, id2);
  });

  it('generates a fresh executionId when none is provided', () => {
    const id = getStreamTabId('polish', 'sonnet');
    assert.match(id, /^polish@sonnet#[0-9a-f]{12}$/);
  });
});
