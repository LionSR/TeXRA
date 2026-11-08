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
  inRunSession,
  type RunToolCall,
} from '@agent/runtime/RunCall';
import {
  BACKGROUND_OUTPUT_HEAD_CHARS,
  BACKGROUND_OUTPUT_TAIL_CHARS,
  formatBashDelivery,
  formatBashError,
  type BackgroundBashCall,
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
import {
  Settings,
  type SettingsStores,
  type StateReadFailed,
} from '@shared/config/settings';
import {
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  GIT_MARK_COMMITS_SETTING,
} from '@shared/state/stateSettings';
import { SessionLog } from '@shared/session/runHistory';
import type { SessionLogShape } from '@shared/session/sessionLog';
import { executed } from '@tools/core/result';
import { previewLabel, stripControlCharacters } from '@utils/text/stringUtils';
import { executeCommand } from '@utils/system/execUtils';
import { appendHead, appendTail } from '@utils/text/appendTail';

// Local file imports
import { defineTool } from './core/definition';
import { nullishWithDefault } from './core/inputSchema';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const SHELL_BACKGROUNDING_PATTERN =
  /(?:^|[\s;])nohup\b[^\n;]*(?<![>&])&(?![>&])/;
const SHELL_BACKGROUNDING_MESSAGE =
  'This command uses shell-level backgrounding (`nohup ... &`) inside a foreground bash tool call. ' +
  'Do not emulate background execution inside the shell; call the bash tool again with `run_in_background: true` and the command without `nohup` or a trailing `&`.';

/**
 * A foreground stream's first and last characters, kept as it arrives so a
 * long command needs no buffer of its whole output, and the text they show:
 * the whole stream when the two windows cover it, else both ends around a
 * note of how much was left out; `null` when nothing but whitespace arrived.
 * Whitespace at either end of the stream takes no room in either window:
 * leading whitespace is dropped, and trailing whitespace waits until
 * something else follows it.
 */
function boundedOutput(streamName: 'stdout' | 'stderr') {
  let head = '';
  let tail = '';
  let totalChars = 0;
  // The whitespace after the last other character, as each window would
  // take it, and its length.
  let pendingHead = '';
  let pendingTail = '';
  let pendingChars = 0;
  const add = (headText: string, tailText: string, chars: number): void => {
    // The head grows only while it holds everything seen: a cut can stop
    // it one short of its budget (before a split surrogate pair), and a
    // later chunk appended after that cut would not follow it.
    if (head.length === totalChars)
      head = appendHead(head, headText, TOOL_RESULT_TRUNCATION_HEAD_CHARS);
    totalChars += chars;
    tail = appendTail(tail, tailText, TOOL_RESULT_TRUNCATION_TAIL_CHARS);
  };
  return {
    append(chunk: string): void {
      const text = totalChars === 0 ? chunk.trimStart() : chunk;
      const content = text.trimEnd();
      if (content) {
        if (pendingChars > 0) add(pendingHead, pendingTail, pendingChars);
        add(content, content, content.length);
        pendingHead = '';
        pendingTail = '';
        pendingChars = 0;
      }
      const trailing = text.slice(content.length);
      pendingChars += trailing.length;
      pendingHead = appendHead(
        pendingHead,
        trailing,
        TOOL_RESULT_TRUNCATION_HEAD_CHARS,
      );
      pendingTail = appendTail(
        pendingTail,
        trailing,
        TOOL_RESULT_TRUNCATION_TAIL_CHARS,
      );
    },
    text(): string | null {
      if (totalChars === 0) return null;
      const elidedChars = totalChars - head.length - tail.length;
      if (elidedChars > 0)
        return `${head}\n\n[... ${elidedChars.toLocaleString()} characters elided from ${streamName} ...]\n\n${tail}`;
      // The windows overlap: the head, then the part of the tail after it.
      if (totalChars > tail.length)
        return head + appendTail('', tail, totalChars - head.length);
      return tail;
    },
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
    'Run command in background. Returns immediately with run ID and a background task tab. Result delivered as follow-up when complete; `timeout` still bounds the command.',
  ),
});

type BashInput = typeof BashInputSchema.Type;

/**
 * The git identity a shell command runs with, so a `git commit` the agent
 * runs carries it. Read from the calling session's settings at each launch,
 * not once for the process: a process holding several projects attributes
 * each project's commits by that project's own setting. Empty when commit
 * marking is off.
 */
const gitAuthorEnv = Effect.fn('BashTool.gitAuthorEnv')(function* (
  settings: SettingsStores,
): Effect.fn.Return<Record<string, string>, StateReadFailed> {
  if (!(yield* Settings.get(settings, GIT_MARK_COMMITS_SETTING))) return {};
  const name = yield* Settings.get(settings, GIT_AUTHOR_NAME_SETTING);
  const email = yield* Settings.get(settings, GIT_AUTHOR_EMAIL_SETTING);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
});

/**
 * The one turn of a background shell command: it runs the process, records
 * its output on the run's trace as `process.output` rows, and reports the
 * delivery projected from those rows with the command's exit. Everything
 * else a background child needs (its registration, its end and the
 * parent's delivery) is the process run's.
 */
function backgroundBashTurn(params: {
  runId: RunId;
  call: BackgroundBashCall;
  timeoutMs: number;
  cwd: string | undefined;
  /** The project's agent-commit identity ({@link gitAuthorEnv}). */
  env: Record<string, string>;
  logger: AgentTrace;
  /** The session's log, which the turn's output rows are read back from. */
  log: SessionLogShape;
}): ProcessTurn {
  const { runId, call, logger, log } = params;
  const { command } = call;
  // Each stream's output becomes rows as it arrives, up to the cap on both
  // streams together. Past it, a stream still records its first characters
  // up to the delivery's head budget, so its head survives the other
  // stream's volume; the rest it sends is held as a rolling tail (its
  // `elided` characters are what the tail let go), and the tails become the
  // log's last rows when the command ends, however it ends, each marking
  // the gap before it.
  const streams = {
    stdout: { recorded: 0, elided: 0, tail: '' },
    stderr: { recorded: 0, elided: 0, tail: '' },
  };
  let capReached = false;
  const record = (stream: 'stdout' | 'stderr', chunk: string): void => {
    const held = streams[stream];
    if (
      !capReached &&
      streams.stdout.recorded + streams.stderr.recorded + chunk.length <=
        BASH_BACKGROUND_LOG_CAP_CHARS
    ) {
      held.recorded += chunk.length;
      logger.output(stream, chunk);
      return;
    }
    if (!capReached) {
      capReached = true;
      logger.warn(
        `[Stream log truncated at ${(BASH_BACKGROUND_LOG_CAP_CHARS / 1000).toFixed(0)}k chars: each stream's first ${BACKGROUND_OUTPUT_HEAD_CHARS.toLocaleString()} characters are still recorded, and its last ${BACKGROUND_OUTPUT_TAIL_CHARS.toLocaleString()} when the command ends]`,
      );
    }
    // A stream that has begun its tail records nothing more, so its rows
    // stay its first characters, then its tail.
    const head =
      held.tail === ''
        ? appendHead(
            '',
            chunk,
            Math.max(0, BACKGROUND_OUTPUT_HEAD_CHARS - held.recorded),
          )
        : '';
    if (head) {
      held.recorded += head.length;
      logger.output(stream, head);
    }
    const rest = chunk.slice(head.length);
    if (!rest) return;
    const tail = appendTail(held.tail, rest, BACKGROUND_OUTPUT_TAIL_CHARS);
    held.elided += held.tail.length + rest.length - tail.length;
    held.tail = tail;
  };
  const recordTails = (): void => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const { tail, elided } = streams[stream];
      if (tail)
        logger.emit({
          type: 'process.output',
          stream,
          text: tail,
          ...(elided > 0 ? { elided } : {}),
        });
    }
  };

  const run = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* executeCommand(command, {
      cwd: params.cwd,
      env: params.env,
      timeout: params.timeoutMs,
      buffer: false,
      // A stop interrupts this call: its release signals the shell's whole
      // process group, so no backgrounded job or piped child is left.
      onStdout: (chunk) => record('stdout', chunk),
      onStderr: (chunk) => record('stderr', chunk),
    }).pipe(Effect.ensuring(Effect.sync(recordTails)));
    const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
    // The output rows were published as the chunks arrived; past the
    // barrier every one is committed, so the run's rows hold the whole log.
    yield* log.settled;
    const rows = yield* log.display(runId);
    // `executeCommand` never fails on a non-zero exit: it answers with the
    // exit code, which the run's end reads as its failure, its output still
    // delivered. A timeout, a signal and a spawn failure answer no 0.
    return {
      report: formatBashDelivery(runId, call, wallTimeMs, result, rows),
      exit: {
        code: result.noExitCode === true ? null : result.exitCode,
        timedOut: result.timedOut,
      },
    };
  });

  return {
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
    // A background shell delivers its result as a follow-up message; a
    // one-shot run has no later turn to take it, and the session's close
    // would kill the command and discard its result with nothing reported.
    return yield* inRunSession('bash run_in_background', (call) =>
      noLaterTurn(call.run)
        ? Effect.fail(
            new ToolError(
              'bash run_in_background is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Run the command in the foreground instead (omit run_in_background), raising `timeout` if it needs longer than the default.',
            ),
          )
        : executeBackground(call, input, input.timeout, cwd),
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
  const stdout = boundedOutput('stdout');
  const stderr = boundedOutput('stderr');
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* executeCommand(command, {
    cwd,
    env: yield* gitAuthorEnv(toolCall.env.roots),
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
  const retainedStdout = stdout.text() ?? result.stdout;
  const retainedStderr = stderr.text() ?? result.stderr;

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
  const env = yield* gitAuthorEnv(yield* SessionRoots);
  const log = yield* SessionLog;
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
          env,
          logger,
          log,
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
    'Execute shell commands in the working directory (the project root, or the worktree the run is rooted in). Available environment variables: $PROJECT_DIR (that directory), $PROJECT_NAME (project name). Returns stdout on success, throws error with stderr on failure. Use run_in_background for long-running commands, with `timeout` raised to what they need.',
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
