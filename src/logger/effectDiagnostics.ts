/** Effect diagnostics use the host's existing, secret-redacting output sink. */
// Third-party imports
import { Exit, Layer, Logger, Option, References, Tracer } from 'effect';
import safeStringify from 'safe-stable-stringify';

// Local imports
import { createLog, isDebugModeEnabled } from '@logger/logUtils';

const log = createLog('Effect');
const MAX_SPAN_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_LENGTH = 512;

/** Route native log levels and annotations through the shared host logger. */
const diagnosticLogger = Logger.make<unknown, void>((options) => {
  if (options.logLevel === 'None') return;
  const verbose = options.logLevel === 'Debug' || options.logLevel === 'Trace';
  if (verbose && !isDebugModeEnabled()) return;
  const entry = Logger.formatStructured.log(options);
  const message =
    typeof entry.message === 'string'
      ? entry.message
      : (safeStringify(entry.message) ?? String(entry.message));
  const data = { ...entry, message: undefined };
  switch (options.logLevel) {
    case 'Fatal':
    case 'Error':
      log.error(entry.cause ? `${message}\n${entry.cause}` : message, { data });
      break;
    case 'Warn':
      log.warn(message, { data });
      break;
    case 'Debug':
    case 'Trace':
      log.debug(message, { data });
      break;
    default:
      log.info(message, { data });
  }
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
