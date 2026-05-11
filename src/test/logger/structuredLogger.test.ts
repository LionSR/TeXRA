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

  it('isolates overlapping async group scopes on the same logger', async () => {
    const sink = new MemorySink();
    const logger = createStructuredLogger(sink);
    let releaseOuter: () => void = () => undefined;

    const outer = logger.withGroup('outer', async () => {
      logger.info('outer start');
      await new Promise<void>((resolve) => {
        releaseOuter = resolve;
      });
      logger.info('outer end');
    });

    await logger.withGroup('other', async () => {
      logger.info('other message');
    });
    releaseOuter();
    await outer;

    assert.deepEqual(
      sink.records.map((record) => record.groups),
      [['outer'], ['other'], ['outer']],
    );
  });

  it('isolates async group scopes across logger instances', async () => {
    const firstSink = new MemorySink();
    const secondSink = new MemorySink();
    const first = createStructuredLogger(firstSink);
    const second = createStructuredLogger(secondSink);

    await first.withGroup('first', async () => {
      first.info('first message');
      second.info('second message');
      assert.equal(first.activeGroupId(), 'first');
      assert.equal(second.activeGroupId(), undefined);
    });

    assert.deepEqual(
      firstSink.records.map((record) => record.groups),
      [['first']],
    );
    assert.deepEqual(
      secondSink.records.map((record) => record.groups),
      [[]],
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
