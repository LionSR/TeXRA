// Node imports
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { tryProcessRuntime } from '@platform/processRuntime';
import type { LogLevel } from '@shared/schemas';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Minimal structured-log primitives. The CLI uses these to format every
 * progress event as either NDJSON or human-readable text on stdout/stderr.
 * Previously lived in `@logger/structuredLogger`; inlined here because the
 * CLI is the only consumer.
 */
interface LogFields {
  readonly [key: string]: unknown;
}

interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void>;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createCliLogger(sink: LogSink): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void =>
    sink.write({
      ts: new Date().toISOString(),
      level,
      message,
      fields: fields ?? {},
    });
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    error: (m, f) => write('error', m, f),
  };
}

const closed = { stdout: false, stderr: false };

type StreamKey = 'stdout' | 'stderr';

function isCliPipeClosureError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

let pipeErrorHandlersInstalled = false;

export function installCliPipeErrorHandlers(): void {
  if (pipeErrorHandlersInstalled) return;
  pipeErrorHandlersInstalled = true;

  for (const key of ['stdout', 'stderr'] as const) {
    process[key].on('error', (error) => {
      if (isCliPipeClosureError(error)) {
        closed[key] = true;
        return;
      }
      throw error;
    });
  }
}

function openStream(key: StreamKey): (typeof process)[StreamKey] | undefined {
  if (closed[key]) return undefined;
  const stream = process[key];
  return stream.destroyed ? undefined : stream;
}

// CLI output is best effort: a synchronous throw from `stream.write` or a
// write error reported to its callback marks the stream closed and settles
// instead of throwing — throwing from here would bypass the command error
// boundary and can crash the process.
function guardedStreamWrite(
  key: StreamKey,
  stream: (typeof process)[StreamKey],
  text: string,
  onSettled: () => void,
): Effect.Effect<void> {
  return Effect.try({
    try: () => {
      stream.write(text, (error) => {
        if (error) closed[key] = true;
        onSettled();
      });
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        closed[key] = true;
        onSettled();
      }),
    ),
  );
}

// The Effect programs here run on the process runtime when one is installed.
// Both edges where none is — an early command error before
// `installCliProcessRuntime` (`bin/texra.ts` top-level catch), and the
// exit-path flushes after `disposeProcessRuntime` — run the same guarded
// write on Effect's default runtime. A synchronous throw from `stream.write`
// still has to mark the stream closed and settle, not crash: this path is
// production, not a debug fallback.
function runSyncWrite(effect: Effect.Effect<void>): void {
  const runtime = tryProcessRuntime();
  if (runtime) runtime.runSync(effect);
  else Effect.runSync(effect);
}

function writeRaw(key: StreamKey, text: string): void {
  const stream = openStream(key);
  if (!stream) return;
  runSyncWrite(guardedStreamWrite(key, stream, text, () => undefined));
}

function writeRawAndWait(key: StreamKey, text: string): Promise<void> {
  const stream = openStream(key);
  if (!stream) return Promise.resolve();
  const runtime = tryProcessRuntime();
  const program = Effect.callback<void>((resume) => {
    runSyncWrite(
      guardedStreamWrite(key, stream, text, () => resume(Effect.void)),
    );
  });
  return runtime ? runtime.runPromise(program) : Effect.runPromise(program);
}

export function writeTextStdout(text: string): void {
  writeRaw('stdout', `${text}\n`);
}

export function writeRawStdout(text: string): void {
  writeRaw('stdout', text);
}

export function writeRawStderr(text: string): void {
  writeRaw('stderr', text);
}

/** Return the current stderr width without exposing the process stream. */
export function getStderrColumns(): number | undefined {
  return process.stderr.columns;
}

export function writeTextStderr(text: string): void {
  writeRaw('stderr', `${text}\n`);
}

export function writeTextStderrAndWait(text: string): Promise<void> {
  return writeRawAndWait('stderr', `${text}\n`);
}

/** Wait until every stderr write queued before this call has completed. */
export function flushTextStderr(): Promise<void> {
  return writeRawAndWait('stderr', '');
}

/**
 * Write a caught error's human-readable message to stderr. Folds the
 * `writeTextStderr(toErrorMessage(error))` pair every command's catch block
 * repeated so the error-formatting choice lives in one place.
 */
export function writeErrorStderr(error: unknown): void {
  writeTextStderr(toErrorMessage(error));
}

/** Swallows readline's echo so a typed secret never reaches the terminal. */
class SilentWritable extends Writable {
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

export async function askCliQuestion(
  question: string,
  options: {
    readonly input?: NodeJS.ReadableStream & { ref?: () => void };
    readonly output?: NodeJS.WritableStream;
    /** Hide the typed answer: readline's echo goes to a swallowing sink and
     *  the question is written straight to stderr instead. */
    readonly hidden?: boolean;
  } = {},
): Promise<string> {
  const input = options.input ?? process.stdin;
  // Ink releases its ownership of stdin with `unref()` when a TUI exits.
  // A following readline prompt must acquire its own live handle or Node can
  // terminate while the top-level command is still awaiting the answer.
  input.ref?.();
  if (options.hidden) writeRawStderr(question);
  const prompt = createInterface({
    input,
    output: options.hidden
      ? new SilentWritable()
      : (options.output ?? process.stderr),
    // A swallowing non-TTY output would otherwise leave stdin in canonical
    // mode, where the TTY driver echoes the secret itself.
    ...(options.hidden ? { terminal: true } : {}),
  });
  try {
    return await prompt.question(options.hidden ? '' : question);
  } finally {
    prompt.close();
    if (options.hidden) writeRawStderr('\n');
  }
}

class StderrTextSink implements LogSink {
  write(record: LogRecord): void {
    writeTextStderr(
      `${record.ts} ${record.level.toUpperCase()} ${record.message}`,
    );
  }
}

interface NdjsonWritable {
  /**
   * False once the target can no longer accept writes. The target owns this
   * answer so the sink never has to ask whether it happens to be holding
   * `process.stdout` and consult the module-level pipe-closure flag itself.
   */
  readonly usable: boolean;
  write(text: string): boolean;
  once(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
}

const processStdoutTarget: NdjsonWritable = {
  get usable(): boolean {
    return !process.stdout.destroyed && !closed.stdout;
  },
  write: (text) => process.stdout.write(text),
  once: (event, listener) => process.stdout.once(event, listener),
  off: (event, listener) => process.stdout.off(event, listener),
};

/**
 * One FIFO write lane per sink: records land on stdout strictly in call
 * order, and a backpressured write holds the lane until its drain arrives.
 * Keyed weakly by the sink, whose lifetime bounds it.
 */
const sinkLanes = new WeakMap<NdjsonStdoutSink, PerKeyLane>();

export class NdjsonStdoutSink implements LogSink {
  private stdoutClosed = false;

  constructor(private readonly stdout: NdjsonWritable = processStdoutTarget) {}

  write(record: LogRecord): void {
    this.writeRecord({ kind: 'log', ...record });
  }

  writeRecord(record: CliNdjsonRecord): void {
    if (this.isClosed()) return;
    const runtime = tryProcessRuntime();
    if (!runtime) {
      // No-runtime edge (`texra version --output-format ndjson` builds no
      // platform; post-disposal nothing queues): no lane fiber can be waiting
      // ahead of this record, so a direct write keeps the lane's call order.
      // A synchronous stringify/write throw still closes the sink.
      Effect.runSync(
        Effect.try({
          try: () => {
            this.stdout.write(`${JSON.stringify(record)}\n`);
          },
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.sync(() => this.closeQueue()))),
      );
      return;
    }
    runtime.runFork(withPerKeyLane(sinkLanes, this)(this.writeLine(record)));
  }

  /** Resolves once every record queued before this call has landed: the FIFO
   *  lane runs this no-op only after them. */
  flush(): Promise<void> {
    const runtime = tryProcessRuntime();
    if (!runtime) {
      // Before `installCliProcessRuntime` every write took the direct path
      // and already landed; after `disposeProcessRuntime` the runtime's
      // scope close has interrupted any lane fiber still waiting on a drain.
      // Either way nothing remains to wait for.
      return Promise.resolve();
    }
    return runtime.runPromise(withPerKeyLane(sinkLanes, this)(Effect.void));
  }

  /**
   * Writes one queued record, honouring backpressure. Never fails: the fiber
   * is forked unobserved, so a failure would die unreported. A failed write
   * or an unserializable record closes the sink.
   */
  private writeLine(record: CliNdjsonRecord): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.isClosed()) {
        this.closeQueue();
        return;
      }
      const writeResult = yield* Effect.try({
        try: () => this.stdout.write(`${JSON.stringify(record)}\n`),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            this.closeQueue();
            return undefined;
          }),
        ),
      );
      // A throw closed the sink above; only a successful write that returned
      // false is backpressure and waits for drain.
      if (writeResult === undefined) return;
      if (!writeResult && !(yield* this.waitForStdoutDrain())) {
        this.closeQueue();
      }
    });
  }

  private isClosed(): boolean {
    return this.stdoutClosed || !this.stdout.usable;
  }

  /** Records still queued behind a closed stdout write nothing when they run. */
  private closeQueue(): void {
    this.stdoutClosed = true;
  }

  private waitForStdoutDrain(): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      if (!this.stdout.usable) return Effect.succeed(false);
      const stdout = this.stdout;
      return Effect.callback<boolean>((resume) => {
        const onDrain = (): void => {
          cleanup();
          resume(Effect.succeed(true));
        };
        const onClosed = (): void => {
          cleanup();
          resume(Effect.succeed(false));
        };
        const cleanup = (): void => {
          stdout.off('drain', onDrain);
          stdout.off('error', onClosed);
          stdout.off('close', onClosed);
        };
        stdout.once('drain', onDrain);
        stdout.once('error', onClosed);
        stdout.once('close', onClosed);
        return Effect.sync(cleanup);
      });
    });
  }
}

const ndjsonStdoutSink = new NdjsonStdoutSink();

/** Queue one public NDJSON record on the process-wide stdout serializer. */
export function writeNdjsonStdout(record: CliNdjsonRecord): void {
  ndjsonStdoutSink.writeRecord(record);
}

/** Wait until all queued public NDJSON and structured log records are written. */
export function flushNdjsonStdout(): Promise<void> {
  return ndjsonStdoutSink.flush();
}

// CLI logs to stdout/stderr are not redacted — operators are expected to
// inspect their own terminals. Desktop logs (which can be exported and shared)
// are redacted in `desktopAppLog.ts` via the shared `redactSecrets` helper.
export function createCliLogSink(format: string): LogSink {
  return format === 'ndjson' ? ndjsonStdoutSink : new StderrTextSink();
}
