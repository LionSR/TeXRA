// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { createRunTrace } from '@logger';

describe('AgentLogger error data', () => {
  beforeEach(async () => {
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);
    await store.clear();
  });

  it('emits error data with stack', () => {
    const logger = createRunTrace('TestErrorLogger').trace;
    const err = new Error('test failure');
    logger.error(`Error occurred: ${err.message}`, { data: err });
    const log = getDefaultStreamLogStore().get('TestErrorLogger');
    const captured = log?.getRange(0, log.head).at(-1) as
      | { data: any }
      | undefined;
    assert.ok(captured);
    assert.strictEqual(captured.data.message, 'test failure');
    assert.ok(captured.data.stack);
  });
});
