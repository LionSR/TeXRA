/** Effect diagnostics use the host's existing, secret-redacting log sink. */
// Third-party imports
import { Exit, Layer, Logger, References, Tracer } from 'effect';

// Local imports
import { writeLogEntry } from '@logger/logSink';

const MAX_SPAN_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_LENGTH = 512;

/**
 * The emission threshold a host builds its runtime with, from facts that
 * cannot change mid-process: the surface kind (the extension's
 * `LogOutputChannel` filters for itself, so it takes `Trace`; the desktop's
 * rotated log file takes `Debug`) or a CLI flag (`--quiet` / `--verbose`).
 * A live user setting must never be routed here — the reference is
 * fiberCached and read before any logger runs, so it would freeze the
 * setting for a whole session.
 */
export type MinimumLogLevel =
  'Trace' | 'Debug' | 'Info' | 'Warn' | 'Error' | 'Fatal' | 'None';

/**
 * Route native log levels through the shared host sink. `formatStructured`
 * already carries level, timestamp, fiber, cause, annotations, and spans, so
 * the entry needs no adaptation and nothing is flattened into a message. The
 * host's choice of {@link MinimumLogLevel} is the only filter: nothing here
 * drops a level the runtime admitted.
 */
const diagnosticLogger = Logger.make<unknown, void>((options) => {
  if (options.logLevel === 'None') return;
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
  }
}

/**
 * Local diagnostics for a process runtime, at the emission threshold the
 * composition root chose. No exporter or retained collection is installed;
 * callers can still provide their own Tracer on an individual Effect.
 */
export const effectDiagnosticsLayer = (
  minimumLogLevel: MinimumLogLevel,
): Layer.Layer<never> =>
  Layer.mergeAll(
    Logger.layer([diagnosticLogger]),
    Layer.succeed(References.MinimumLogLevel)(minimumLogLevel),
    Layer.succeed(Tracer.Tracer)(
      Tracer.make({
        span: (options) => new DiagnosticSpan({ ...options, links: [] }),
      }),
    ),
  );
