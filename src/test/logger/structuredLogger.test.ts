// Standard library imports
import { strict as assert } from 'assert';

// Local imports - logger
import {
  createStructuredLogger,
  type LogRecord,
  type LogSink,
  MemorySink,
} from '@logger/structuredLogger';

class FlushCountingSink implements LogSink {
  readonly records: LogRecord[] = [];
  flushCount = 0;
  closed = false;

  write(record: LogRecord): void {
    this.records.push(record);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('structuredLogger', () => {
  it('records nested groups and exposes the active group id', async () => {
    const sink = new MemorySink();
    const logger = createStructuredLogger(sink);

    await logger.withGroup('outer', async () => {
      assert.equal(logger.activeGroupId(), 'outer');
      logger.info('outer message');
      await logger.withGroup('inner', async () => {
        assert.equal(logger.activeGroupId(), 'inner');
        logger.warn('inner message');
      });
      assert.equal(logger.activeGroupId(), 'outer');
    });

    assert.equal(logger.activeGroupId(), undefined);
    assert.deepEqual(
      sink.records.map((record) => record.groups),
      [['outer'], ['outer', 'inner']],
    );
  });

  it('handles out-of-order group closers without leaking later groups', () => {
    const sink = new MemorySink();
    const logger = createStructuredLogger(sink);
    const leaveOuter = logger.group('outer');
    const leaveInner = logger.group('inner');

    leaveOuter();
    logger.info('after outer close');
    leaveInner();
    logger.info('after all close');

    assert.deepEqual(
      sink.records.map((record) => record.groups),
      [['inner'], []],
    );
  });

  it('flushes and closes the old sink when swapping sinks', async () => {
    const first = new FlushCountingSink();
    const second = new FlushCountingSink();
    const logger = createStructuredLogger(first);

    logger.info('before swap');
    await logger.swapSink(second);
    logger.info('after swap');

    assert.equal(first.flushCount, 1);
    assert.equal(first.closed, true);
    assert.equal(first.records.length, 1);
    assert.equal(second.records.length, 1);
  });
});
