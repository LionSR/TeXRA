// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import { bus } from '@eventBus/ProgressEventBus';
import { createChannelLogger } from '@logger/logUtils';

describe('Channel logger error data', () => {
  it('emits error data with stack', () => {
    const logger = createChannelLogger('TestErrorLogger');
    const err = new Error('test failure');
    let captured: any;
    const off = bus.on('addLogMessage', (payload) => {
      if (payload.stream === 'TestErrorLogger') {
        captured = payload.logMessage;
      }
    });
    logger.error(`Error occurred: ${err.message}`, undefined, undefined, err);
    off();
    assert.ok(captured);
    assert.strictEqual(captured.data.message, 'test failure');
    assert.ok(captured.data.stack);
  });
});
