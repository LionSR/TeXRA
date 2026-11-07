// Node imports
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Third-party imports
import { Effect, PlatformError, Predicate } from 'effect';

// Local imports
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import {
  entryChannel,
  entryMessage,
  type LogEntry,
  type LogSink as HostLogSink,
} from '@texra-ai/harness/node';
import {
  CLI_NDJSON_CONTRACT,
  type CliNdjsonRecord,
} from '@cli/schemas/cliOutput';

const closed = { stdout: false, stderr: false };

type StreamKey = 'stdout' | 'stderr';

function isCliPipeClosureError(error: unknown): boolean {
  if (!Predicate.hasProperty(error, 'code')) return false;
  const code = error.code;
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

/** A synchronous throw from `write` (including `JSON.stringify` in the
 *  thunk) goes to `onSyncThrow` and never crashes the process. */
function bestEffortStreamWrite(
  write: () => void,
  onSyncThrow: (error: unknown) => void,
) {
  try {
    write();
  } catch (error) {
    onSyncThrow(error);
  }
}

// CLI output is best effort, and a fire-and-forget write has nothing to wait
// for: Node's stream keeps call order and buffers under backpressure, and the
// event loop stays alive until buffered writes land. A synchronous throw from
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

// A waiting write resolves once the stream has written `text` and everything
// queued before it. Its callers are the exit edges — the resume hint, the chat
// TUI's teardown warning, and the shutdown sequence's final flushes before
// `process.exit`, which drops whatever an asynchronous pipe still buffers. The
// stream's write callback is the foreign edge, wrapped exactly once here.
function writeRawAndWait(key: StreamKey, text: string): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const stream = openStream(key);
    if (!stream) return resume(Effect.void);
    bestEffortStreamWrite(
      () =>
        stream.write(text, (error) => {
          if (error) closed[key] = true;
          resume(Effect.void);
        }),
      () => {
        closed[key] = true;
        resume(Effect.void);
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

/** Return the current stdout width without exposing the process stream. */
export function getStdoutColumns(): number | undefined {
  return process.stdout.columns;
}

export function writeTextStderr(text: string): void {
  writeRaw('stderr', `${text}\n`);
}

export function writeTextStderrAndWait(text: string): Effect.Effect<void> {
  return writeRawAndWait('stderr', `${text}\n`);
}

/** Wait until every stderr write queued before this call has completed. */
export function flushTextStderr(): Effect.Effect<void> {
  return writeRawAndWait('stderr', '');
}

/** Wait until every stdout write queued before this call has completed. */
export function flushStdout(): Effect.Effect<void> {
  return writeRawAndWait('stdout', '');
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
 * Write a caught error's human-readable message to stderr. Replaces the
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
    /** Hide the typed answer: readline's echo goes to a swallowing sink and
     *  the question is written straight to stderr instead. */
    readonly hidden?: boolean;
  } = {},
): Effect.Effect<string, Error> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      // When stdin is a file it has no `ref`.
      const input: NodeJS.ReadableStream & { ref?: () => void } = process.stdin;
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
          : process.stderr,
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
 * The harness's console fallback sends DEBUG and INFO to stdout, and
 * the process runtime logs while its layers build (`UsageLogService started
 * …`) — before `CliPlatform` runs its own `setLogSink`, and for `clone`
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

/**
 * The sink of a process that wants no diagnostics at all: `defineCliCommand`
 * installs it for a command run with `--quiet` before it builds the process
 * runtime, and the CLI platform init installs it for every command that
 * reaches one, since each command renders its own output.
 */
export const silentLogSink: HostLogSink = Object.freeze({
  write: () => undefined,
});

/** Set once an NDJSON record fails to serialize or write: the records after
 *  it would describe a stream with a hole in it, so none are written. */
let ndjsonClosed = false;

/** Write one public NDJSON record to stdout, stamped with the contract. */
export function writeNdjsonStdout(record: CliNdjsonRecord): void {
  if (ndjsonClosed) return;
  const stream = openStream('stdout');
  if (!stream) return;
  bestEffortStreamWrite(
    () =>
      stream.write(
        // Appended, never prepended: line-oriented consumers anchor on the
        // record's leading `{"kind":`.
        `${JSON.stringify({ ...record, contract: CLI_NDJSON_CONTRACT })}\n`,
        (error) => {
          if (error) closed.stdout = true;
        },
      ),
    (error) => {
      // Closed first, so this report cannot re-enter the broken output. A
      // throw here (including a stringify of a malformed record, which is a
      // producer bug) must not pass without a trace.
      ndjsonClosed = true;
      writeTextStderr(
        `[warn] [cli.output] An NDJSON record could not be written; NDJSON output is closed for the rest of this process: ${toErrorMessage(error)}`,
      );
    },
  );
}
