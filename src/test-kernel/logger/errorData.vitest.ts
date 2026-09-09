import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { StreamLog } from '@shared/session/traceEntries';
import { createTestRunTrace } from '@test/support/sessionTestUtils';

describe('AgentTrace error data', () => {
  it('emits error data with stack', () => {
    const store = new StreamLog();
    const logger = createTestRunTrace('TestErrorLogger', store).trace;
    const err = new Error('test failure');
    logger.error(`Error occurred: ${err.message}`, { data: err });
    const log = store;
    const captured = log?.getRange(0, log.head).at(-1) as
      { data: Error } | undefined;
    assert.ok(captured);
    assert.strictEqual(captured.data.message, 'test failure');
    assert.ok(captured.data.stack);
  });
});
