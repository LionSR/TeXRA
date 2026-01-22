// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import { AgentLogger } from '@logger/AgentLogger';
import { bus } from '@eventBus/ProgressEventBus';

describe('AgentLogger error data', () => {
  it('emits error data with stack', () => {
    const logger = new AgentLogger('TestErrorLogger');
    const err = new Error('test failure');
    let captured: any;
    const off = bus.on('addLogMessage', (payload) => {
      if (payload.streamId === 'TestErrorLogger') {
        captured = payload.logMessage;
      }
    });
    logger.error(`Error occurred: ${err.message}`, { data: err });
    off();
    assert.ok(captured);
    assert.strictEqual(captured.data.message, 'test failure');
    assert.ok(captured.data.stack);
  });
});
