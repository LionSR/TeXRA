// Third-party imports
import { Clock, Effect, Schema, type Scope } from 'effect';

// Local imports
import type { AgentTrace } from '@agent/trace/AgentTrace';
import {
  TOOL_RESULT_TRUNCATION_HEAD_CHARS,
  TOOL_RESULT_TRUNCATION_TAIL_CHARS,
} from '@agent/runtime/run/toolResultText';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import {
  noLaterTurn,
  requireToolRun,
  type RunToolCall,
} from '@agent/runtime/RunCall';
import {
  formatBashDelivery,
  formatBashError,
  type BackgroundBashCall,
  type BashDeliveryStreamExcerpt,
} from '@agent/runtime/delegation/bashDelivery';
import {
  launchProcessChild,
  type ProcessTurn,
} from '@agent/runtime/processRun';
import { SessionRoots } from '@platform/rootedFs';
import {
  BASH_BACKGROUND_LOG_CAP_CHARS,
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
} from '@shared/toolUse';
import { ToolError, type RunId, type ToolResult } from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settings';
import { executed } from '@tools/core/result';
import { previewLabel, stripControlCharacters } from '@utils/text/stringUtils';
import { executeCommand } from '@utils/system/execUtils';
import { appendHead, appendTail } from '@utils/text/appendTail';

// Local file imports
import { defineTool } from './core/definition';
import { nullishWithDefault } from './core/inputSchema';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const BACKGROUND_OUTPUT_TAIL_CHARS = 12_000;
/**
 * Small head budget retained alongside the tail, at roughly the foreground
 * head:tail ratio. A long background build's first fatal error tends to sit
 * near the top of the log, well before the tail budget's trailing window;
 * without this, output that outgrows the tail silently drops that error with
 * no way to recover it from the follow-up.
 */
const BACKGROUND_OUTPUT_HEAD_CHARS = 1_000;
const FOREGROUND_OUTPUT_HEAD_CHARS = TOOL_RESULT_TRUNCATION_HEAD_CHARS;
const FOREGROUND_OUTPUT_TAIL_CHARS = TOOL_RESULT_TRUNCATION_TAIL_CHARS;
const SHELL_BACKGROUNDING_PATTERN =
  /(?:^|[\s;])nohup\b[^\n;]*(?<![>&])&(?![>&])/;
const SHELL_BACKGROUNDING_MESSAGE =
  'This command uses shell-level backgrounding (`nohup ... &`) inside a foreground bash tool call. ' +
  'Do not emulate background execution inside the shell; call the bash tool again with `run_in_background: true` and the command without `nohup` or a trailing `&`.';

interface BoundedOutputCapture {
  append(chunk: string): void;
  text(streamName: 'stdout' | 'stderr'): string | null;
  /** Retained leading window (up to `headChars`). */
  readonly head: string;
  /** Retained trailing window (up to `tailChars`). */
  readonly tail: string;
  /** Total characters observed (after whitespace normalization, when enabled). */
  readonly totalChars: number;
}

/**
 * @param options.normalizeWhitespace When true (the default, used by the
 *   foreground path) leading whitespace is dropped and trailing whitespace is
 *   deferred so a stream that ends in blank lines is not counted or shown. The
 *   background path passes false and tracks head/tail/total byte-for-byte.
 */
function createBoundedOutputCapture(
  headChars: number,
  tailChars: number,
  options?: { normalizeWhitespace?: boolean },
): BoundedOutputCapture {
  const normalizeWhitespace = options?.normalizeWhitespace ?? true;
  let head = '';
  let tail = '';
  let totalChars = 0;
  let hasNonWhitespace = false;
  let pendingWhitespaceHead = '';
  let pendingWhitespaceTail = '';
  let pendingWhitespaceChars = 0;

  const appendText = (text: string): void => {
    totalChars += text.length;
    head = appendHead(head, text, headChars);
    tail = appendTail(tail, text, tailChars);
  };

  const appendPendingWhitespace = (text: string): void => {
    if (!text) return;
    pendingWhitespaceChars += text.length;
    pendingWhitespaceHead = appendHead(pendingWhitespaceHead, text, headChars);
    pendingWhitespaceTail = appendTail(pendingWhitespaceTail, text, tailChars);
  };

  const commitPendingWhitespace = (): void => {
    if (pendingWhitespaceChars === 0) return;

    totalChars += pendingWhitespaceChars;
    head = appendHead(head, pendingWhitespaceHead, headChars);
    tail = appendTail(tail, pendingWhitespaceTail, tailChars);
    pendingWhitespaceHead = '';
    pendingWhitespaceTail = '';
    pendingWhitespaceChars = 0;
  };

  return {
    get head(): string {
      return head;
    },
    get tail(): string {
      return tail;
    },
    get totalChars(): number {
      return totalChars;
    },
    append(chunk: string): void {
      if (!normalizeWhitespace) {
        if (chunk.length > 0) hasNonWhitespace = true;
        appendText(chunk);
        return;
      }

      let text = chunk;
      if (!hasNonWhitespace) {
        text = text.trimStart();
        if (!text) return;
        hasNonWhitespace = true;
      }

      const withoutTrailingWhitespace = text.trimEnd();
      if (!withoutTrailingWhitespace) {
        appendPendingWhitespace(text);
        return;
      }

      commitPendingWhitespace();
      appendText(withoutTrailingWhitespace);
      appendPendingWhitespace(text.slice(withoutTrailingWhitespace.length));
    },
    text(streamName: 'stdout' | 'stderr'): string | null {
      if (!hasNonWhitespace) return null;
      if (totalChars <= tail.length) return tail || null;

      const elidedChars = Math.max(0, totalChars - head.length - tail.length);
      const overlapChars = Math.max(0, head.length + tail.length - totalChars);
      const nonOverlappingTail =
        overlapChars > 0
          ? appendTail('', tail, tail.length - overlapChars)
          : tail;
      return elidedChars > 0
        ? `${head}\n\n[... ${elidedChars.toLocaleString()} characters elided from ${streamName} ...]\n\n${nonOverlappingTail}`
        : head + nonOverlappingTail;
    },
  };
}

/**
 * Only surface the head when the tail actually dropped earlier content —
 * otherwise the tail already holds the full stream and a separate head block
 * would just repeat it. When it did, also report how many characters sit in
 * the gap between head and tail, mirroring the foreground
 * `checkToolResultTextLimit` elision note.
 */
function toDeliveryExcerpt(
  capture: BoundedOutputCapture,
): BashDeliveryStreamExcerpt {
  const truncated = capture.totalChars > capture.tail.length;
  return {
    tail: capture.tail,
    head: truncated ? capture.head : '',
    elidedChars: truncated
      ? Math.max(
          0,
          capture.totalChars - capture.head.length - capture.tail.length,
        )
      : 0,
  };
}

const BashInputSchema = Schema.Struct({
  command: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'A short description of what the command does, in 5-10 words (e.g. "Run the unit tests"). It names the call in the transcript and the background task list; execution ignores it.',
  }),
  timeout: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)).check(
      Schema.isLessThanOrEqualTo(600_000),
    ),
    BASH_TOOL_DEFAULT_TIMEOUT_MS,
    'Timeout in milliseconds (max 600,000 ms / 10 min, default 120,000 ms / 2 min).',
  ),
  run_in_background: nullishWithDefault(
    Schema.Boolean,
    false,
    'Run command in background. Returns immediately with run ID and a background task tab. Result delivered as follow-up when complete.',
  ),
});

type BashInput = typeof BashInputSchema.Type;

/**
 * The one turn of a background shell command: it runs the process, records
 * its output on the run's trace, and reports the formatted delivery with
 * the command's exit. Everything else a background child needs (its
 * registration, its end and the parent's delivery) is the process run's.
 */
function backgroundBashTurn(params: {
  runId: RunId;
  call: BackgroundBashCall;
  timeoutMs: number;
  cwd: string | undefined;
  /**
   * The launching session's setting slots, so a `git commit` the background
   * shell runs carries the project's configured agent identity.
   */
  settings: SettingsStores;
  logger: AgentTrace;
}): ProcessTurn {
  const { runId, call, logger } = params;
  const { command } = call;
  // Whitespace normalization is off here: a background log is delivered
  // verbatim, and its head/tail budgets are its own (see the constants above)
  // rather than the foreground tool-result ones.
  const captureOptions = { normalizeWhitespace: false };
  const stdout = createBoundedOutputCapture(
    BACKGROUND_OUTPUT_HEAD_CHARS,
    BACKGROUND_OUTPUT_TAIL_CHARS,
    captureOptions,
  );
  const stderr = createBoundedOutputCapture(
    BACKGROUND_OUTPUT_HEAD_CHARS,
    BACKGROUND_OUTPUT_TAIL_CHARS,
    captureOptions,
  );
  let recordedChars = 0;
  let capReached = false;
  const record = (stream: 'stdout' | 'stderr', chunk: string): void => {
    if (capReached) return;
    recordedChars += chunk.length;
    if (recordedChars > BASH_BACKGROUND_LOG_CAP_CHARS) {
      capReached = true;
      logger.warn(
        `[Stream log truncated at ${(BASH_BACKGROUND_LOG_CAP_CHARS / 1000).toFixed(0)}k chars: tail available in follow-up result]`,
      );
      return;
    }
    logger.output(stream, chunk);
  };

  const run = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* executeCommand(command, {
      cwd: params.cwd,
      settings: params.settings,
      timeout: params.timeoutMs,
      buffer: false,
      // A stop interrupts this call: its release signals the shell's whole
      // process group, so no backgrounded job or piped child is left.
      onStdout: (chunk) => {
        stdout.append(chunk);
        record('stdout', chunk);
      },
      onStderr: (chunk) => {
        stderr.append(chunk);
        record('stderr', chunk);
      },
    });
    const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
    // `executeCommand` never fails on a non-zero exit: it answers with the
    // exit code, so the failure is reported, its output still delivered.
    return {
      report: formatBashDelivery(
        runId,
        call,
        wallTimeMs,
        result,
        toDeliveryExcerpt(stdout),
        toDeliveryExcerpt(stderr),
      ),
      ...(result.success
        ? {}
        : {
            failure: `Background bash failed with exit code ${result.exitCode}.`,
          }),
      exit: {
        code: result.noExitCode === true ? null : result.exitCode,
        timedOut: result.timedOut,
      },
    };
  });

  return {
    stageLabel: 'Background command',
    run,
    reportError: (error) => formatBashError(runId, call, error),
  };
}

const executeBashTool = Effect.fn('executeBashTool')(function* (
  input: BashInput,
) {
  const toolCall = yield* ToolContext;
  if (
    !input.run_in_background &&
    SHELL_BACKGROUNDING_PATTERN.test(input.command)
  ) {
    return yield* Effect.fail(new ToolError(SHELL_BACKGROUNDING_MESSAGE));
  }

  const cwd = toolCall.env.workingDirectory ?? toolCall.env.roots.workspace;

  if (input.run_in_background) {
    const call = yield* requireToolRun('bash run_in_background');
    // A background shell delivers its result as a follow-up message; a
    // one-shot run has no later turn to take it, and the session's close
    // would kill the command and discard its result with nothing reported.
    if (noLaterTurn(call.run))
      return yield* Effect.fail(
        new ToolError(
          'bash run_in_background is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Run the command in the foreground instead (omit run_in_background), raising `timeout` if it needs longer than the default.',
        ),
      );
    return yield* executeBackground(call, input, input.timeout, cwd).pipe(
      Effect.provide(call.session),
    );
  }

  return yield* executeForeground(input.command, input.timeout, toolCall, cwd);
});

const executeForeground = Effect.fn('BashTool.executeForeground')(function* (
  command: string,
  timeoutMs: number,
  toolCall: ToolContext['Service'],
  cwd?: string,
): Effect.fn.Return<ToolResult, Error, Scope.Scope | ChildProcessSpawner> {
  const stdout = createBoundedOutputCapture(
    FOREGROUND_OUTPUT_HEAD_CHARS,
    FOREGROUND_OUTPUT_TAIL_CHARS,
  );
  const stderr = createBoundedOutputCapture(
    FOREGROUND_OUTPUT_HEAD_CHARS,
    FOREGROUND_OUTPUT_TAIL_CHARS,
  );
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* executeCommand(command, {
    cwd,
    // The call's own session roots: a `git commit` the agent runs
    // carries this project's configured identity.
    settings: toolCall.env.roots,
    buffer: false,
    timeout: timeoutMs,
    // The string command form gets shell teardown: interruption and
    // timeout signal the whole process group so piped children and
    // backgrounded jobs are torn down.
    onStdout: (chunk) => {
      stdout.append(chunk);
      toolCall.emit(chunk);
    },
    onStderr: (chunk) => {
      stderr.append(chunk);
      toolCall.emit(chunk);
    },
  });
  // Spawn/cancellation diagnostics can come from executeCommand itself
  // rather than either subprocess stream, so retain those as a fallback.
  const retainedStdout = stdout.text('stdout') ?? result.stdout;
  const retainedStderr = stderr.text('stderr') ?? result.stderr;

  if (result.timedOut) {
    const parts: string[] = [
      `Foreground command timed out after ${timeoutMs / 1000}s.`,
    ];
    if (retainedStdout) parts.push(`<stdout>${retainedStdout}</stdout>`);
    if (retainedStderr) parts.push(`<stderr>${retainedStderr}</stderr>`);
    parts.push(
      `To fix, either:\n` +
        `- Increase the timeout parameter up to 600s (600000ms): { "timeout": 600000 }\n` +
        `- Set run_in_background: true to execute asynchronously: { "run_in_background": true }\n` +
        `Do not use shell-level backgrounding such as \`nohup ... &\` inside a foreground call.`,
    );
    return yield* Effect.fail(new ToolError(parts.join('\n')));
  }

  const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
  const duration = `${(elapsedMs / 1000).toFixed(1)}s`;

  if (result.success) {
    const preview = previewLabel(command);
    return executed(
      retainedStdout,
      `Executed: ${preview} (exit 0, ${duration})`,
    );
  }
  // Many CLI tools write errors to stdout, not stderr
  const errorOutput =
    [retainedStderr, retainedStdout].filter(Boolean).join('\n') ||
    'No error output available';
  return yield* Effect.fail(
    new ToolError(`Command failed (${duration}): ${errorOutput}`),
  );
});

const executeBackground = Effect.fn('BashTool.executeBackground')(function* (
  call: RunToolCall,
  input: BackgroundBashCall,
  timeoutMs: number,
  cwd?: string,
) {
  const { command } = input;
  const preview = previewLabel(command);
  const settings = yield* SessionRoots;
  // The durable record states only what a shell command has: no run mode,
  // no model. The run's name reaches terminals (the task list): no control
  // characters.
  const runId = yield* launchProcessChild(
    { runId: call.run.runId, logId: call.logId },
    {
      identity: { kind: 'process', tool: 'bash' },
      config: { name: 'bash', instruction: command },
      description: stripControlCharacters(
        input.description?.trim() || command,
        ' ',
      ).trim(),
      turn: ({ logger, runId }) =>
        backgroundBashTurn({
          runId,
          call: input,
          timeoutMs,
          cwd,
          settings,
          logger,
        }),
    },
  );
  return executed(
    [
      `Command launched in background.`,
      `Run ID: ${runId}`,
      'Result arrives automatically as a follow-up message when complete. Continue other work or end your turn.',
      `To read its output so far (works while it runs): executions tool with path=/executions/${runId}/output`,
      `Only if you cannot proceed without the result, block with the executions tool: path=/executions/${runId} action=wait`,
    ].join('\n'),
    `Launched background: ${preview}`,
  );
});

export const BashTool = defineTool({
  name: 'bash',
  slow: true,
  description:
    'Execute shell commands directly in the workspace directory. Commands run from the project root automatically. Available environment variables: $PROJECT_DIR (workspace path), $PROJECT_NAME (project name). Returns stdout on success, throws error with stderr on failure. Use run_in_background for long-running commands.',
  schema: BashInputSchema,
  // The command this call runs; the loop gets it approved before the body.
  guard: {
    command: {
      text: (input: BashInput) => input.command,
      grant: 'bash',
    },
  },
  execute: executeBashTool,
});
