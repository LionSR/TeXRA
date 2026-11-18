// Node imports
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Third-party imports
import { Effect, LogLevel, Predicate, Schema } from 'effect';

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

/** Wait until every write queued on `stream` before this call has completed. */
export function flush(stream: StreamKey): Effect.Effect<void> {
  return writeRawAndWait(stream, '');
}

/** A CLI entry's one run threw: `cause` is what it threw, reported as is. */
export class CliEntryCrashed extends Schema.TaggedError<CliEntryCrashed>()(
  'CliEntryCrashed',
  { cause: Schema.Defect() },
) {}

/** The user-facing text of a caught error: the CLI's one wording of a
 *  failure, which every command prints through. */
export function cliErrorMessage(error: unknown): string {
  return toErrorMessage(error);
}

/** Write a caught error's human-readable message to stderr. */
export function writeErrorStderr(error: unknown): void {
  writeTextStderr(cliErrorMessage(error));
}

/** A question on stdin got no answer: the input ended, or readline failed. */
class CliQuestionUnanswered extends Schema.TaggedError<CliQuestionUnanswered>()(
  'CliQuestionUnanswered',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Ask one question on stdin. The readline interface is the foreign edge and is
 * wrapped exactly once here: acquire opens it, use awaits the answer or the
 * end of the input, and release closes it on success, failure and
 * interruption alike.
 */
export function askCliQuestion(
  question: string,
  options: {
    /** Hide the typed answer: readline's echo goes to a swallowing sink and
     *  the question is written straight to stderr instead. */
    readonly hidden?: boolean;
  } = {},
): Effect.Effect<string, CliQuestionUnanswered> {
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
      Effect.raceFirst(
        Effect.tryPromise({
          try: () => prompt.question(options.hidden ? '' : question),
          catch: (cause) =>
            new CliQuestionUnanswered({
              message: ensureError(cause).message,
              cause,
            }),
        }),
        // readline leaves a pending question unanswered for good when its
        // input ends (Ctrl-D, a closed pipe); its `close` is the answer.
        Effect.callback<never, CliQuestionUnanswered>((resume) => {
          prompt.once('close', () =>
            resume(
              Effect.fail(
                new CliQuestionUnanswered({
                  message: 'The input ended before an answer.',
                }),
              ),
            ),
          );
        }),
      ),
    (prompt) =>
      Effect.sync(() => {
        prompt.close();
        if (options.hidden) writeRawStderr('\n');
      }),
  );
}

/**
 * Ask a yes-or-no question on stdin, with the `[Y/n]` or `[y/N]` hint its
 * default decides. An empty answer takes the default; any other answer is
 * yes only when it is `y` or `yes`, in any case.
 */
export function confirmCliQuestion(
  question: string,
  options: { readonly default: boolean },
): Effect.Effect<boolean, CliQuestionUnanswered> {
  return askCliQuestion(
    `${question} ${options.default ? '[Y/n]' : '[y/N]'} `,
  ).pipe(
    Effect.map((answer) => {
      const trimmed = answer.trim();
      return trimmed === '' ? options.default : /^y(es)?$/i.test(trimmed);
    }),
  );
}

/**
 * The process's diagnostic sink at `minimumLogLevel`, the level the
 * context decided from argv: each entry at that level or above on stderr,
 * as `[channel] message`, so stdout stays the command's result. The
 * runtime drops an `Effect.log*` below the level before it gets here; the
 * sink applies it to the fiberless writes too. `None` (`--quiet`) writes
 * nothing. A command keeps this sink for its whole life; the chat replaces
 * it with {@link silentLogSink} while Ink owns the terminal.
 */
export function stderrDiagnosticSink(
  minimumLogLevel: LogLevel.LogLevel,
): HostLogSink {
  return Object.freeze({
    write(entry: LogEntry) {
      if (
        minimumLogLevel === 'None' ||
        LogLevel.isLessThan(ENTRY_LOG_LEVEL[entry.level], minimumLogLevel)
      )
        return;
      const channel = entryChannel(entry);
      writeTextStderr(
        `${channel ? `[${channel}] ` : ''}${entryMessage(entry)}`,
      );
    },
  });
}

/** The `LogLevel` each entry level was logged at. */
const ENTRY_LOG_LEVEL = Object.freeze({
  FATAL: 'Fatal',
  ERROR: 'Error',
  WARN: 'Warn',
  INFO: 'Info',
  DEBUG: 'Debug',
  TRACE: 'Trace',
}) satisfies { [L in LogEntry['level']]: LogLevel.Severity };

/** The sink of a surface that owns the terminal (the chat's Ink frame) or
 *  whose own output reports every failure (`texra doctor`). */
export const silentLogSink: HostLogSink = Object.freeze({
  write: () => undefined,
});

/** Set once an NDJSON record fails to serialize or write: the records after
 *  it would describe a stream with a hole in it, so none are written. */
let ndjsonClosed = false;

/** Write one public NDJSON record to stdout, stamped with the time it is
 *  written (`ts`) and the contract. */
export function writeNdjsonStdout(record: CliNdjsonRecord): void {
  if (ndjsonClosed) return;
  const stream = openStream('stdout');
  if (!stream) return;
  bestEffortStreamWrite(
    () =>
      stream.write(
        // Appended, never prepended: line-oriented consumers anchor on the
        // record's leading `{"kind":`.
        `${JSON.stringify({ ...record, ts: new Date().toISOString(), contract: CLI_NDJSON_CONTRACT })}\n`,
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
