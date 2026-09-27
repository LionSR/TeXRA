// Node imports
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Third-party imports
import { Effect, PlatformError } from 'effect';

// Local imports
import {
  CLI_NDJSON_CONTRACT,
  type CliNdjsonRecord,
} from '@cli/schemas/cliOutput';
import {
  entryChannel,
  entryMessage,
  type LogEntry,
  type LogSink as HostLogSink,
} from '@logger/logSink';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { LogLevel } from '@shared/schemas';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { bestEffortStreamWrite } from './bestEffortStreamWrite';

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

interface LogSink {
  write(record: LogRecord): void;
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

export function installCliPipeErrorHandlers(): void {
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

/**
 * The process runtime the NDJSON sink queues its lane fibers on, handed over
 * by `installCliProcessRuntime` and taken back once that install has been
 * disposed (#12720). `null` is a state the plane is in, not a lookup that
 * failed: it is what the sink's no-runtime edge below is, and the direct
 * write it takes there is production behaviour rather than a fallback.
 */
let logRuntime: ProcessRuntime | null = null;

export function setCliLogRuntime(runtime: ProcessRuntime | null): void {
  logRuntime = runtime;
}

// CLI output is best effort, and a fire-and-forget write has nothing to wait
// for, so it never needs the process runtime: a synchronous throw from
// `stream.write` or a write error reported to its callback marks the stream
// closed instead of propagating. Throwing from here would bypass the command
// error boundary and can crash the process.
function writeRaw(key: StreamKey, text: string): void {
  const stream = openStream(key);
  if (!stream) return;
  bestEffortStreamWrite(
    () =>
      stream.write(text, (error) => {
        if (error) closed[key] = true;
      }),
    () => {
      closed[key] = true;
    },
  );
}

// A waiting write takes the direct path unconditionally. Its callers are the
// exit edges — the resume hint, the chat TUI's teardown warning, and the
// shutdown sequence's final flush, which runs after the process runtime has
// been disposed — so it must never run on that runtime, and the settle
// callback is the promise's own resolve rather than a run nested inside
// another.
function writeRawAndWait(key: StreamKey, text: string): Promise<void> {
  const stream = openStream(key);
  if (!stream) return Promise.resolve();
  return new Promise<void>((resolve) => {
    bestEffortStreamWrite(
      () =>
        stream.write(text, (error) => {
          if (error) closed[key] = true;
          resolve();
        }),
      () => {
        closed[key] = true;
        resolve();
      },
    );
  });
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

/** Wait until every stderr write queued before this call has completed. The
 *  stream write callback is the foreign edge and is wrapped exactly once
 *  here, so the shutdown sequence yields this instead of lifting it. */
export function flushTextStderr(): Effect.Effect<void> {
  return Effect.promise(() => writeRawAndWait('stderr', ''));
}

/**
 * The user-facing text of a caught error. A `PlatformError`'s own message is
 * `Tag: FileSystem.method (path)`, with no errno text; its Node cause carries
 * the real reason (`ENOSPC: no space left on device, copyfile 'a' -> 'b'`),
 * so that is what the CLI prints.
 */
export function cliErrorMessage(error: unknown): string {
  return toErrorMessage(
    error instanceof PlatformError.PlatformError
      ? (error.reason.cause ?? error)
      : error,
  );
}

/**
 * Write a caught error's human-readable message to stderr. Folds the
 * `writeTextStderr(cliErrorMessage(error))` pair every command's catch block
 * repeated so the error-formatting choice lives in one place.
 */
export function writeErrorStderr(error: unknown): void {
  writeTextStderr(cliErrorMessage(error));
}

/**
 * Ask one question on stdin. The readline interface is the foreign edge and is
 * wrapped exactly once here: acquire opens it, use awaits the answer, and
 * release closes it on success, failure and interruption alike — the last of
 * which the `try`/`finally` this replaced could not see.
 */
export function askCliQuestion(
  question: string,
  options: {
    readonly input?: NodeJS.ReadableStream & { ref?: () => void };
    readonly output?: NodeJS.WritableStream;
    /** Hide the typed answer: readline's echo goes to a swallowing sink and
     *  the question is written straight to stderr instead. */
    readonly hidden?: boolean;
  } = {},
): Effect.Effect<string, Error> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const input = options.input ?? process.stdin;
      // Ink releases its ownership of stdin with `unref()` when a TUI exits.
      // A following readline prompt must acquire its own live handle or Node
      // can terminate while the caller is still awaiting the answer.
      input.ref?.();
      if (options.hidden) writeRawStderr(question);
      return createInterface({
        input,
        output: options.hidden
          ? // Swallow readline's echo so the typed secret never reaches the terminal.
            new Writable({ write: (_chunk, _encoding, callback) => callback() })
          : (options.output ?? process.stderr),
        // A swallowing non-TTY output would otherwise leave stdin in canonical
        // mode, where the TTY driver echoes the secret itself.
        ...(options.hidden ? { terminal: true } : {}),
      });
    }),
    (prompt) =>
      Effect.tryPromise({
        try: () => prompt.question(options.hidden ? '' : question),
        catch: ensureError,
      }),
    (prompt) =>
      Effect.sync(() => {
        prompt.close();
        if (options.hidden) writeRawStderr('\n');
      }),
  );
}

/**
 * The host diagnostic sink of this process until a platform installs its own.
 * `@logger/logSink`'s console fallback sends DEBUG and INFO to stdout, and
 * the process runtime logs while its layers build (`UsageLogService started
 * …`) — before `initCliPlatform` runs its own `setLogSink`, and for `clone`
 * and `install-github-action` before a platform that never comes up. Under
 * `--output-format ndjson` that line is the first thing on stdout and the
 * stream stops being parseable. This renders the same line `consoleLogSink`
 * does, with every level on stderr: nothing is dropped, and stdout stays the
 * command's result. Installed by `bin/texra.ts` as its first statement and
 * again by `defineCliCommand` once the context has answered `--quiet`.
 */
export const prePlatformDiagnosticSink: HostLogSink = Object.freeze({
  write(entry: LogEntry) {
    const channel = entryChannel(entry);
    writeTextStderr(`${channel ? `[${channel}] ` : ''}${entryMessage(entry)}`);
  },
});

/** Text mode: the presentation records a run shows the user, in the same
 *  `LEVEL message` shape as the CLI's config warnings. The timestamp stays in
 *  the NDJSON record; on stderr it only made the line read like a log dump
 *  between the progress lines. */
class StderrTextSink implements LogSink {
  write(record: LogRecord): void {
    writeTextStderr(`${record.level.toUpperCase()} ${record.message}`);
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

  writeRecord(unstamped: CliNdjsonRecord): void {
    if (this.isClosed()) return;
    // Appended, never prepended: line-oriented consumers anchor on the
    // record's leading `{"kind":`.
    const record = { ...unstamped, contract: CLI_NDJSON_CONTRACT };
    const runtime = logRuntime;
    if (!runtime) {
      // No-runtime edge (`texra version --output-format ndjson` builds no
      // platform; post-disposal nothing queues): no lane fiber can be waiting
      // ahead of this record, so a direct write keeps the lane's call order.
      // A synchronous stringify/write throw still closes the sink.
      bestEffortStreamWrite(
        () => this.stdout.write(`${JSON.stringify(record)}\n`),
        () => this.closeQueue(),
      );
      return;
    }
    runtime.runFork(withPerKeyLane(sinkLanes, this)(this.writeLine(record)));
  }

  /** Settles once every record queued before this call has landed: the FIFO
   *  lane runs this no-op only after them. */
  flush(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!logRuntime) {
        // Before `installCliProcessRuntime` every write took the direct path
        // and already landed; after its disposal the runtime's
        // scope close has interrupted any lane fiber still waiting on a drain.
        // Either way nothing remains to wait for.
        return Effect.void;
      }
      return withPerKeyLane(sinkLanes, this)(Effect.void);
    });
  }

  /**
   * Writes one queued record, honouring backpressure. Never fails: the fiber
   * is forked unobserved, so a failure would die unreported. A failed write
   * or an unserializable record closes the sink — loudly, on stderr, since a
   * write that throws (including a stringify of a malformed record, which is
   * a producer bug) must not pass without a trace.
   */
  private writeLine(record: CliNdjsonRecord): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.isClosed()) return;
      const writeResult = yield* Effect.try({
        try: () => this.stdout.write(`${JSON.stringify(record)}\n`),
        catch: ensureError,
      }).pipe(
        Effect.catch((cause: unknown) =>
          Effect.sync(() => {
            // Closed first, so this report cannot re-enter the broken sink.
            this.closeQueue();
            writeTextStderr(
              `[warn] [cli.output] A queued NDJSON record could not be written; the sink is closed for the rest of this process: ${toErrorMessage(cause)}`,
            );
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
export function flushNdjsonStdout(): Effect.Effect<void> {
  return ndjsonStdoutSink.flush();
}

// CLI logs to stdout/stderr are not redacted — operators are expected to
// inspect their own terminals. Desktop logs (which can be exported and shared)
// are redacted in `desktopAppLog.ts` via the shared `redactSecrets` helper.
export function createCliLogSink(format: string): LogSink {
  return format === 'ndjson' ? ndjsonStdoutSink : new StderrTextSink();
}
