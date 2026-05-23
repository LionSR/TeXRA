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
  it('writes per-call fields into the sink record', () => {
    const sink = new CapturingSink();
    const logger = createStructuredLogger(sink);

    logger.info('hello', { streamId: 's1', runId: 'r1' });

    assert.equal(sink.records.length, 1);
    assert.equal(sink.records[0]?.level, 'info');
    assert.equal(sink.records[0]?.message, 'hello');
    assert.deepEqual(sink.records[0]?.fields, {
      streamId: 's1',
      runId: 'r1',
    });
    assert.deepEqual(sink.records[0]?.groups, []);
  });

  it('routes each level to the sink with the correct level tag', () => {
    const sink = new CapturingSink();
    const logger = createStructuredLogger(sink);

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    assert.deepEqual(
      sink.records.map((r) => r.level),
      ['debug', 'info', 'warn', 'error'],
    );
  });
});
