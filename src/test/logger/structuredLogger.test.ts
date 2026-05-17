// Standard library imports
import { strict as assert } from 'assert';

// Local imports - logger
import {
  createStructuredLogger,
  type LogRecord,
  type LogSink,
} from '@logger/structuredLogger';

class CapturingSink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

describe('structuredLogger', () => {
  it('records nested groups and exposes the active group id', async () => {
    const sink = new CapturingSink();
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

  it('isolates overlapping async group scopes on the same logger', async () => {
    const sink = new CapturingSink();
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
    const firstSink = new CapturingSink();
    const secondSink = new CapturingSink();
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

  it('child loggers inherit fields and contribute them to records', () => {
    const sink = new CapturingSink();
    const root = createStructuredLogger(sink);
    const child = root.child({ streamId: 's1' });

    child.info('child message', { runId: 'r1' });

    assert.deepEqual(sink.records[0]?.fields, {
      streamId: 's1',
      runId: 'r1',
    });
  });
});
