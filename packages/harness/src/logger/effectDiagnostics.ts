/** Effect runtime diagnostics over the host's existing, secret-redacting log
 *  sink: a process's and a view's logger, and fork-failure reporting. */
// Third-party imports
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Logger,
  type LogLevel,
  type ManagedRuntime,
  References,
  Tracer,
} from 'effect';

// Local imports
import { writeLogEntry } from '@logger/logSink';

const MAX_SPAN_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_LENGTH = 512;

/**
 * Route native log levels through the shared host sink. `formatStructured`
 * already carries level, timestamp, fiber, cause, annotations, and spans, so
 * the entry needs no adaptation and nothing is flattened into a message. The
 * host's minimum level is the only filter: nothing here
 * drops a level the runtime admitted. `errorsAsWarnings` demotes ERROR and
 * FATAL for a view (`viewDiagnosticsLayer`).
 */
const sinkLogger = (errorsAsWarnings: boolean) =>
  Logger.make<unknown, void>((options) => {
    if (options.logLevel === 'None') return;
    const entry = Logger.formatStructured.log(options);
    writeLogEntry(
      errorsAsWarnings && (entry.level === 'ERROR' || entry.level === 'FATAL')
        ? { ...entry, level: 'WARN' }
        : entry,
    );
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
 *
 * The threshold comes from facts that cannot change mid-process: the surface
 * kind (the extension's `LogOutputChannel` filters for itself, so it takes
 * `Trace`; the desktop's rotated log file takes `Debug`) or a CLI flag
 * (`--quiet` / `--verbose`). A live user setting must never be routed here:
 * the reference is fiberCached and read before any logger runs, so it would
 * freeze the setting for a whole session.
 */
export const effectDiagnosticsLayer = (
  minimumLogLevel: LogLevel.LogLevel,
): Layer.Layer<never> =>
  Layer.mergeAll(
    Logger.layer([sinkLogger(false)]),
    Layer.succeed(References.MinimumLogLevel)(minimumLogLevel),
    Layer.succeed(Tracer.Tracer)(
      Tracer.make({
        span: (options) => new DiagnosticSpan({ ...options, links: [] }),
      }),
    ),
  );

/**
 * The logger of a view's runtime, which builds no process diagnostics layer:
 * each entry takes the log sink's write path, redacted unless a host marked
 * the sink trusted, instead of Effect's default console logger.
 *
 * ERROR/FATAL are written as WARN: a view has no host log channel, and
 * Electron's smoke harness treats `console.error` (the console sink's ERROR
 * path) as a failed view. Fork-failure reports and fold defects still show
 * in DevTools after redaction.
 */
export const viewDiagnosticsLayer: Layer.Layer<never> = Logger.layer([
  sinkLogger(true),
]);

/**
 * An exit the fiber's interruption produced. Interrupting a consumer of a
 * PubSub-backed stream (`SubscriptionRef.changes`, `Stream.fromPubSub`) adds
 * Effect's end-of-stream `Done` failure beside the interrupt: the channel
 * ends its subscription on interrupt by signalling `Done`. That is the stream
 * closing, not a failure, so an interrupt accompanied only by `Done` counts
 * as an interruption too.
 */
function isInterruption(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.some(Cause.isInterruptReason) &&
    cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) ||
        (Cause.isFailReason(reason) && Cause.isDone(reason.error)),
    )
  );
}

/**
 * A runtime whose `runFork` reports a fiber's failure or defect on exit.
 * `Fiber.addObserver` fires on every exit, including fibers a
 * caller later `Fiber.join`s, so a joined failure is logged here and still
 * delivered to the joiner. A success stays silent, as does an exit made of
 * interrupts alone or of interrupts beside Effect's end-of-stream `Done`.
 * `runPromise` and `runSync` hand their exits to the caller already.
 */
export function withForkFailureReporting<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
): ManagedRuntime.ManagedRuntime<R, ER> {
  // The report forks on the underlying `runFork`, not the observed one: a
  // defect in the reporter itself must not recurse back into this observer.
  const reportExit = (
    fiberId: number,
    exit: Exit.Exit<unknown, unknown>,
  ): void => {
    if (Exit.isSuccess(exit) || isInterruption(exit.cause)) return;
    runtime.runFork(
      Effect.logError('Unhandled failure in forked fiber', exit.cause).pipe(
        Effect.annotateLogs({ forkedFiber: fiberId }),
      ),
    );
  };
  return {
    ...runtime,
    runFork: (effect, options) => {
      const fiber = runtime.runFork(effect, options);
      fiber.addObserver((exit) => reportExit(fiber.id, exit));
      return fiber;
    },
  };
}
