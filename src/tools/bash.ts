import { Effect, type Scope } from 'effect';

// Third-party imports
import { z } from 'zod';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { registerRun } from '@agent/storage/runLifecycle';
import {
  TOOL_RESULT_TRUNCATION_HEAD_CHARS,
  TOOL_RESULT_TRUNCATION_TAIL_CHARS,
} from '@agent/runtime/run/toolResultText';
import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import { ToolCall } from '@agent/runtime/ToolCall';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  BASH_BACKGROUND_LOG_CAP_CHARS,
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
  backgroundBashOutputData,
} from '@shared/toolUse';
import {
  AgentCategory,
  ToolError,
  type ExecResult,
  type RunId,
  type ToolResult,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import {
  formatBashDelivery,
  formatBashError,
  type BashDeliveryStreamExcerpt,
} from '@tools/delegation/bashDelivery';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { executed } from '@tools/core/result';
import { formatDuration, generateRunId } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import { previewLabel } from '@utils/text/stringUtils';
import { executeCommand } from '@utils/system/execUtils';
import { appendHead, appendTail } from '@utils/text/appendTail';

// Local file imports
import { defineTool } from './core/define';
import { nullishWithDefault } from './core/inputSchema';
import { childRunDescription, createChildRun } from './delegation/childRun';
import { startDetachedChildRunLoop } from './delegation/detachedChildRun';
import { parseWorkingDirectory } from './pathResolution';

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

const BashInputSchema = z.strictObject({
  command: z.string(),
  description: z
    .string()
    .nullish()
    .describe(
      'Optional human-readable purpose for the command. Ignored by execution.',
    ),
  timeout: z
    .int()
    .min(1000)
    .max(600_000)
    .nullish()
    .describe(
      'Timeout in milliseconds (max 600,000 ms / 10 min, default 120,000 ms / 2 min).',
    ),
  run_in_background: nullishWithDefault(z.boolean(), false).describe(
    'Run command in background. Returns immediately with run ID and a background task tab. Result delivered as follow-up when complete.',
  ),
});

type BashInput = z.infer<typeof BashInputSchema>;

/**
 * The child-run strategy for one background shell command: a single terminal
 * turn that runs the process, streams its output into the child's tab, and
 * hands the loop the formatted delivery and result manifest. Everything else a
 * background child needs — the follow-up queue claim, the wake-aware parent
 * delivery, report persistence, the interrupt target, and terminal
 * finalization — is the loop's, exactly as it is for every other child type.
 */
function createBackgroundBashStrategy(params: {
  runId: RunId;
  command: string;
  timeoutMs: number;
  cwd: string | undefined;
  logger: AgentTrace;
}): ChildRunStrategy<ExecResult> {
  const { runId, command, logger } = params;
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
  let loggedChars = 0;
  let logCapReached = false;
  const logChunk = (chunk: string, level: 'info' | 'warn'): void => {
    if (logCapReached) return;
    loggedChars += chunk.length;
    if (loggedChars > BASH_BACKGROUND_LOG_CAP_CHARS) {
      logCapReached = true;
      logger.warn(
        `[Stream log truncated at ${(BASH_BACKGROUND_LOG_CAP_CHARS / 1000).toFixed(0)}k chars: tail available in follow-up result]`,
      );
      return;
    }
    logger[level](chunk, {
      data: backgroundBashOutputData(level === 'warn' ? 'stderr' : 'stdout'),
    });
  };

  let startedAt = Date.now();
  const delivery = (result: ExecResult, wallTimeMs: number): string =>
    formatBashDelivery(
      runId,
      command,
      wallTimeMs,
      result,
      toDeliveryExcerpt(stdout),
      toDeliveryExcerpt(stderr),
    );

  return {
    stageLabel: 'Background command',
    // A background shell is the one child type that owns a live OS process and
    // whose tab is ephemeral, and the one whose result survives its own kill.
    ownsBackgroundProcess: true,
    autoCloseChildRun: true,
    deliverAfterInterrupt: true,

    launch: (_ports, signal) =>
      Effect.tryPromise({
        try: () => {
          startedAt = Date.now();
          return executeCommand(command, {
            ...(params.cwd !== undefined && { cwd: params.cwd }),
            timeout: params.timeoutMs,
            buffer: false,
            // The string command form gets shell teardown: abort/timeout signal
            // the whole process group so backgrounded jobs and piped children are
            // torn down rather than left running.
            signal,
            onStdout: (chunk) => {
              stdout.append(chunk);
              logChunk(chunk, 'info');
            },
            onStderr: (chunk) => {
              stderr.append(chunk);
              logChunk(chunk, 'warn');
            },
          });
        },
        catch: ensureError,
      }),

    isTerminal: () => true,
    // `executeCommand` never rejects on a non-zero exit — it resolves with the
    // exit code, so the failure is an application-level one.
    isTurnError: (turn) => !turn.success,
    onTurnError: (turn, turnLogger) =>
      turnLogger.error(
        `Background bash failed with exit code ${turn.exitCode}.`,
      ),

    formatDelivery: (turn, wallTimeMs) => delivery(turn, wallTimeMs),
    // A failed exit still produced real output: deliver the full excerpt, not
    // the bare error form. `formatBashError` is only for a throw, where there
    // is no result to report.
    formatError: (turn, err) =>
      turn
        ? delivery(turn, Date.now() - startedAt)
        : formatBashError(runId, command, err),

    buildResultMeta: (turn, _isError, wallTimeMs) =>
      Effect.sync(() =>
        turn
          ? {
              producer: 'backgroundBash' as const,
              exitCode: turn.exitCode,
              wallTimeMs,
              success: turn.success,
              timedOut: turn.timedOut,
              command,
            }
          : undefined,
      ),
  };
}

export class BashTool extends defineTool({
  name: 'bash',
  requiresApproval: true,
  slow: true,
  deferLogUntilApproval: true,
  streamsOutput: true,
  description:
    'Execute shell commands directly in the workspace directory. Commands run from the project root automatically. Available environment variables: $PROJECT_DIR (workspace path), $PROJECT_NAME (project name). Returns stdout on success, throws error with stderr on failure. Use run_in_background for long-running commands.',
  schema: BashInputSchema,
}) {
  protected execute(input: BashInput) {
    return Effect.gen({ self: this }, function* () {
      const toolCall = yield* ToolCall;
      if (
        !input.run_in_background &&
        SHELL_BACKGROUNDING_PATTERN.test(input.command)
      ) {
        return yield* Effect.fail(new ToolError(SHELL_BACKGROUNDING_MESSAGE));
      }

      // A background shell delivers its result as a follow-up message; a
      // one-shot run ends after the current cycle, so nothing is left to collect
      // it. Every other child type already answers this case — agent-CLI
      // refuses, native subagents degrade to the parent trace, workflow-script
      // awaits — and a background shell cannot degrade, because the follow-up
      // IS its delivery. Refuse before requesting approval: in the SDK path
      // (`packages/agent/src/index.ts`) the `finally` kills the process group,
      // so launching here would run the user's command and then discard its
      // result with nothing reported.
      if (input.run_in_background && toolCall.stopAfterCycle) {
        return yield* Effect.fail(
          new ToolError(
            'bash run_in_background is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Run the command in the foreground instead (omit run_in_background), raising `timeout` if it needs longer than the default.',
          ),
        );
      }

      const cwd =
        parseWorkingDirectory(toolCall.workingDirectory) ??
        toolCall.inScope(() => workspaceRoots().workspace);

      const approval = yield* requestBashApproval({
        command: input.command,
        cwd,
      });

      if (approval.action !== 'approve') {
        return buildBashApprovalRejectedResult(input.command, approval);
      }

      toolCall.hooks?.onRunReady?.();

      const timeoutMs = input.timeout ?? BASH_TOOL_DEFAULT_TIMEOUT_MS;

      if (input.run_in_background) {
        if (!toolCall.run) {
          return yield* Effect.fail(
            new ToolError(
              'bash run_in_background must be called from within an agent stream.',
            ),
          );
        }
        return yield* this.executeBackground(
          toolCall.run.session,
          input.command,
          timeoutMs,
          toolCall.run.runId,
          cwd,
        );
      }

      return yield* this.executeForeground(
        input.command,
        timeoutMs,
        toolCall,
        cwd,
      );
    });
  }

  private readonly executeForeground = Effect.fn('BashTool.executeForeground')(
    function* (
      this: BashTool,
      command: string,
      timeoutMs: number,
      toolCall: import('@agent/runtime/ToolCall').ToolCallShape,
      cwd?: string,
    ): Effect.fn.Return<ToolResult, Error, Scope.Scope> {
      const stdout = createBoundedOutputCapture(
        FOREGROUND_OUTPUT_HEAD_CHARS,
        FOREGROUND_OUTPUT_TAIL_CHARS,
      );
      const stderr = createBoundedOutputCapture(
        FOREGROUND_OUTPUT_HEAD_CHARS,
        FOREGROUND_OUTPUT_TAIL_CHARS,
      );
      const startedAt = Date.now();
      const signal = yield* Effect.abortSignal;
      const result = yield* Effect.tryPromise({
        try: () =>
          executeCommand(command, {
            cwd,
            buffer: false,
            timeout: timeoutMs,
            // The string command form gets shell teardown: abort/timeout signal the
            // whole process group so piped children and backgrounded jobs are torn
            // down.
            onStdout: (chunk) => {
              stdout.append(chunk);
              toolCall.hooks?.onToolOutput?.(chunk);
            },
            onStderr: (chunk) => {
              stderr.append(chunk);
              toolCall.hooks?.onToolOutput?.(chunk);
            },
            signal,
          }),
        catch: ensureError,
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

      const duration = formatDuration(Date.now() - startedAt);

      if (result.success) {
        const preview = previewLabel(command);
        return executed(
          retainedStdout ?? '',
          `Executed: ${preview} (exit 0, ${duration})`,
        );
      }
      // Many CLI tools (including latexmk) write errors to stdout, not stderr
      const errorOutput =
        [retainedStderr, retainedStdout].filter(Boolean).join('\n') ||
        'No error output available';
      return yield* Effect.fail(
        new ToolError(`Command failed (${duration}): ${errorOutput}`),
      );
    },
  );

  private readonly executeBackground = Effect.fn('BashTool.executeBackground')(
    function* (
      session: SessionHandle,
      command: string,
      timeoutMs: number,
      parentRunId: RunId,
      cwd?: string,
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const runId = generateRunId();
          const preview = previewLabel(command);

          const syntheticConfig = AgentConfigSchema.parse({
            agent: 'bash',
            instruction: command,
            agentCategory: AgentCategory.ToolUse,
          });

          // The durable record states only what a shell command has: no run
          // mode, no model. The synthetic AgentConfig above feeds the ephemeral
          // live wire only.
          yield* registerRun(
            session,
            runId,
            { name: 'bash', instruction: command },
            'bash',
            {
              identity: { kind: 'process', tool: 'bash' },
              userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
              parentRunId: parentRunId,
              category: AgentCategory.ToolUse,
              description: childRunDescription(command),
            },
          );

          yield* startDetachedChildRunLoop({
            session,
            runId,
            parentRunId,
            agentName: 'bash',
            // A background shell is an external process on no model budget, like
            // the agent-CLI children (see the child-run concurrency budget note).
            budgeted: false,
            createChildRun: () =>
              restore(Effect.void).pipe(
                Effect.andThen(
                  createChildRun(session, runId, parentRunId, {
                    run: { kind: 'process', tool: 'bash' },
                    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
                    description: command,
                    config: syntheticConfig,
                  }),
                ),
              ),
            buildLaunch: (childRun) =>
              Effect.sync(() => {
                return {
                  strategy: createBackgroundBashStrategy({
                    runId,
                    command,
                    timeoutMs,
                    cwd,
                    logger: childRun.logger,
                  }),
                  // Nobody awaits this run: own late loop failures here as trace
                  // diagnostics, since the loop already owns its one user-facing
                  // result delivery.
                  onLoopFailed: (error: unknown): void => {
                    childRun.logger.error(
                      'Background command run loop failed after launch',
                      { data: error },
                    );
                  },
                };
              }),
          });

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
        }),
      );
    },
  );
}
