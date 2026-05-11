// Local imports - logger
import {
  createStructuredLogger,
  type Logger,
  type LogSink,
} from '@logger/structuredLogger';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';
import { NdjsonStdoutSink, StderrTextSink } from './logSinks';

export interface CliLoggerHandle {
  readonly logger: Logger;
  close(): Promise<void>;
}

export function createCliLogger(context: CliContext): CliLoggerHandle {
  const sink: LogSink =
    context.outputFormat === 'ndjson'
      ? new NdjsonStdoutSink()
      : new StderrTextSink();
  return {
    logger: createStructuredLogger(sink),
    async close() {
      await sink.close?.();
      await sink.flush?.();
    },
  };
}
