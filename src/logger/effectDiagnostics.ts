/** Effect diagnostics use the host's existing, secret-redacting log sink. */
// Third-party imports
import { Exit, Layer, Logger, Option, References, Tracer } from 'effect';

// Local imports
import { createLog, isDebugModeEnabled } from '@logger/logUtils';
import { writeLogEntry } from '@logger/logSink';

const log = createLog('Effect');
const MAX_SPAN_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_LENGTH = 512;

/**
 * Route native log levels through the shared host sink. `formatStructured`
 * already carries level, timestamp, fiber, cause, annotations, and spans, so
 * the entry needs no adaptation and nothing is flattened into a message.
 */
const diagnosticLogger = Logger.make<unknown, void>((options) => {
  if (options.logLevel === 'None') return;
  const verbose = options.logLevel === 'Debug' || options.logLevel === 'Trace';
  if (verbose && !isDebugModeEnabled()) return;
  writeLogEntry(Logger.formatStructured.log(options));
});

/**
 * Retain only bounded scalar attributes while a span is live. Span events and
 * links are deliberately omitted from local diagnostics. The output contains
 * neither an operation's return value nor its error body.
 */
class DiagnosticSpan extends Tracer.NativeSpan {
  override attribute(key: string, value: unknown): void {
    if (!this.sampled || key.length > MAX_ATTRIBUTE_LENGTH) return;
    if (
      this.attributes.size >= MAX_SPAN_ATTRIBUTES &&
      !this.attributes.has(key)
    ) {
      return;
    }
    if (typeof value === 'string') {
      super.attribute(key, value.slice(0, MAX_ATTRIBUTE_LENGTH));
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      super.attribute(key, value);
    }
  }

  override event(): void {}

  override addLinks(): void {}

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === 'Ended') return;
    super.end(endTime, exit);
    if (!this.sampled || !isDebugModeEnabled()) return;
    log.debug(`${this.name}: ${exit._tag}`, {
      data: {
        traceId: this.traceId,
        spanId: this.spanId,
        parentSpanId: Option.getOrUndefined(this.parent)?.spanId,
        durationMs: Number(endTime - this.startTime) / 1_000_000,
        attributes: Object.fromEntries(this.attributes),
      },
    });
  }
}

/**
 * Local diagnostics for the process runtime. Successful and failed spans are
 * emitted only in debug mode; no exporter or retained collection is installed.
 * Callers can still provide their own Tracer on an individual Effect.
 */
export const effectDiagnosticsLayer = Layer.mergeAll(
  Logger.layer([diagnosticLogger]),
  Layer.succeed(References.MinimumLogLevel)('Trace'),
  Layer.succeed(Tracer.Tracer)(
    Tracer.make({
      span: (options) => new DiagnosticSpan({ ...options, links: [] }),
    }),
  ),
);
