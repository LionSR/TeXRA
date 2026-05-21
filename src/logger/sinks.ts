// Local imports - logger
import { redactSecrets, type LogRedactionOptions } from './redaction';
import type { LogRecord, LogSink } from './structuredLogger';

export function composeSinks(sinks: readonly LogSink[]): LogSink {
  if (sinks.length === 1) {
    const only = sinks[0];
    if (only) return only;
  }
  return {
    write(record: LogRecord): void {
      for (const sink of sinks) sink.write(record);
    },
    async flush(): Promise<void> {
      await Promise.all(sinks.map((sink) => sink.flush?.()));
    },
    async close(): Promise<void> {
      await Promise.all(sinks.map((sink) => sink.close?.()));
    },
  };
}

export function createFilterSink(
  inner: LogSink,
  transform: (record: LogRecord) => LogRecord,
): LogSink {
  return {
    write(record: LogRecord): void {
      inner.write(transform(record));
    },
    flush: inner.flush ? () => inner.flush!() : undefined,
    close: inner.close ? () => inner.close!() : undefined,
  };
}

export function createRedactingSink(
  inner: LogSink,
  options: LogRedactionOptions = {},
): LogSink {
  return createFilterSink(inner, (record) => {
    const fields = Object.fromEntries(
      Object.entries(record.fields).map(([key, value]) => [
        key,
        typeof value === 'string' ? redactSecrets(value, options) : value,
      ]),
    );

    return {
      ...record,
      message: redactSecrets(record.message, options),
      fields,
      groups: record.groups.map((group) => redactSecrets(group, options)),
    };
  });
}
