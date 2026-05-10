// Local imports - logger
import { StructuredLogger, type Logger } from '@logger/structuredLogger';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';
import { NdjsonStdoutSink, StderrTextSink } from './logSinks';

export function createCliLogger(context: CliContext): Logger {
  const sink =
    context.outputFormat === 'ndjson'
      ? new NdjsonStdoutSink()
      : new StderrTextSink();
  return new StructuredLogger(sink);
}
