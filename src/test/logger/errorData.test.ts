// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';

describe('AgentLogger error data', () => {
  beforeEach(async () => {
    const store = new StreamLogStore();
    AgentLogger.setStreamLogStore(store);
    await store.clear();
  });

  it('emits error data with stack', () => {
    const logger = new AgentLogger('TestErrorLogger', true);
    const err = new Error('test failure');
    logger.error(`Error occurred: ${err.message}`, { data: err });
    const log = AgentLogger.getStreamLogStore().get('TestErrorLogger');
    const captured = log?.getRange(0, log.head).at(-1) as
      | { data: any }
      | undefined;
    assert.ok(captured);
    assert.strictEqual(captured.data.message, 'test failure');
    assert.ok(captured.data.stack);
  });
});
