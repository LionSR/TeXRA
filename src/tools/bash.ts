// Third-party imports
import { z } from 'zod';

// Local imports
import { getExecutionStore, registerExecution } from '@agent/storage';
import {
  captureOwnedExecutionLease,
  markOwnedExecutionLeaseUndurable,
  onOwnedExecutionLeaseLost,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage/executionLease';
import {
  TOOL_RESULT_TRUNCATION_HEAD_CHARS,
  TOOL_RESULT_TRUNCATION_TAIL_CHARS,
} from '@agent/modelHandlers/contextManagementConstants';
import {
  getCurrentToolContexts,
  type ToolCallContext,
} from '@agent/followUp/ToolFileInteractionContext';
import type { RunTerminalPersistence } from '@agent/runtime/AgentRunLifecycle';
import type { ExecutionInterruptHandler } from '@agent/runtime/ExecutionHandle';
import {
  getRunContextExecutionId,
  getRunContextWorkingDirectory,
} from '@agent/runtime/RunContext';
import { currentSession } from '@agent/runtime/SessionHandle';
import { BASH_CHILD_STREAM_PREFIX } from '@agent/runtime/streamTab';
import { releaseExecutionLeaseAfterArtifacts } from '@agent/runtime/executionOwnership';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { tryPlatform } from '@platform/platform';
import {
  BASH_BACKGROUND_LOG_CAP_CHARS,
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
  backgroundBashOutputData,
} from '@shared/toolUse';
import {
  USER_FOLLOW_UP_SUPPORT,
  type StreamTabId,
  type ExecutionId,
} from '@shared/schemas';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { requireRunStream } from '@tools/contextHelpers';
import { deliverChildRunFollowUp } from '@tools/delegation/childRunDelivery';
import {
  formatBashDelivery,
  formatBashError,
  type BashDeliveryStreamExcerpt,
} from '@tools/delegation/subagentResults';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { executed } from '@tools/core/result';
import { formatDuration, generateExecutionId } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { executeCommand } from '@utils/system/execUtils';
import { appendHead, appendTail } from '@utils/text/appendTail';

// Local file imports
import { defineTool } from './core/define';
import {
  childStreamDescription,
  createChildStream,
  getChildStreamId,
  type ChildStream,
} from './delegation/childStream';
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

/**
 * A background command's durable terminal state is written by the shared
 * finalizer, from the outcome the stream phase resolved. Deriving it here from
 * the process exit alone would record ERROR for a command the user killed:
 * the kill lands CANCELLED on the phase and only then does the process exit
 * non-zero. There is no flow to resume, so the record is always dropped.
 */
const BACKGROUND_TERMINAL_PERSISTENCE: RunTerminalPersistence = {
  kind: 'finalize',
  flowRecord: 'delete',
};

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
    tail =
      pendingWhitespaceChars >= tailChars
        ? pendingWhitespaceTail
        : appendTail(tail, pendingWhitespaceTail, tailChars);
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
  run_in_background: z
    .boolean()
    .prefault(false)
    .describe(
      'Run command in background. Returns immediately with execution ID and a background task tab. Result delivered as follow-up when complete.',
    ),
});

type BashInput = z.infer<typeof BashInputSchema>;

/**
 * Interrupt handle for a background bash run. Termination is delegated to
 * `executeCommand`'s own abort-signal path (SIGTERM → SIGKILL escalation,
 * stream cleanup) rather than duplicating a kill ladder here — see
 * `executeCommand`'s `terminateSubprocess`.
 */
class BashBackgroundSession implements ExecutionInterruptHandler {
  /** Shutdown drain reaches this handler via `interruptBackgroundProcess()`. */
  readonly ownsBackgroundProcess = true;
  private readonly abortController = new AbortController();

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  interrupt(): void {
    this.abortController.abort();
  }
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
  protected async execute(input: BashInput): Promise<ToolResult> {
    if (
      !input.run_in_background &&
      SHELL_BACKGROUNDING_PATTERN.test(input.command)
    ) {
      throw new ToolError(SHELL_BACKGROUNDING_MESSAGE);
    }

    const contexts = getCurrentToolContexts();
    const callContext = contexts?.callContext;
    const runContext = contexts?.runContext;
    const cwd =
      parseWorkingDirectory(getRunContextWorkingDirectory(runContext)) ??
      tryPlatform()?.workspace.getWorkspacePath();

    // Request approval before executing the command.
    const approval = await requestBashApproval({ command: input.command, cwd });

    if (approval.action !== 'approve') {
      return buildBashApprovalRejectedResult(input.command, approval.feedback);
    }

    // Signal execution starting (triggers in-progress log after approval)
    callContext?.hooks?.onExecutionReady?.();

    const timeoutMs = input.timeout ?? BASH_TOOL_DEFAULT_TIMEOUT_MS;

    if (input.run_in_background) {
      const { streamId } = requireRunStream(
        'bash run_in_background',
        runContext,
      );
      return this.executeBackground(
        input.command,
        timeoutMs,
        streamId,
        getRunContextExecutionId(runContext),
        cwd,
      );
    }

    return this.executeForeground(input.command, timeoutMs, callContext, cwd);
  }

  private async executeForeground(
    command: string,
    timeoutMs: number,
    ctx: ToolCallContext | undefined,
    cwd?: string,
  ): Promise<ToolResult> {
    const stdout = createBoundedOutputCapture(
      FOREGROUND_OUTPUT_HEAD_CHARS,
      FOREGROUND_OUTPUT_TAIL_CHARS,
    );
    const stderr = createBoundedOutputCapture(
      FOREGROUND_OUTPUT_HEAD_CHARS,
      FOREGROUND_OUTPUT_TAIL_CHARS,
    );
    const startedAt = Date.now();
    const result = await executeCommand(command, {
      cwd,
      buffer: false,
      timeout: timeoutMs,
      onStdout: (chunk) => {
        stdout.append(chunk);
        ctx?.hooks?.onToolOutput?.(chunk);
      },
      onStderr: (chunk) => {
        stderr.append(chunk);
        ctx?.hooks?.onToolOutput?.(chunk);
      },
      signal: ctx?.signal,
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
      throw new ToolError(parts.join('\n'));
    }

    const duration = formatDuration(Date.now() - startedAt);

    if (result.success) {
      const preview = truncateWithEllipsis(command, 60);
      return executed(
        retainedStdout ?? '',
        `Executed: ${preview} (exit 0, ${duration})`,
      );
    }
    // Many CLI tools (including latexmk) write errors to stdout, not stderr
    const errorOutput =
      [retainedStderr, retainedStdout].filter(Boolean).join('\n') ||
      'No error output available';
    throw new ToolError(`Command failed (${duration}): ${errorOutput}`);
  }

  private async executeBackground(
    command: string,
    timeoutMs: number,
    parentStreamId: StreamTabId,
    parentExecutionId: ExecutionId | undefined,
    cwd?: string,
  ): Promise<ToolResult> {
    const executionId = generateExecutionId();

    const preview = truncateWithEllipsis(command, 60);

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'bash',
      instruction: command,
      agentCategory: AgentCategory.ToolUse,
    });

    // The durable record states only what a shell command has: no execution
    // mode, no model. The synthetic AgentConfig above feeds the ephemeral
    // live wire only.
    await registerExecution(
      executionId,
      { name: 'bash', instruction: command },
      'bash',
      {
        streamId: getChildStreamId(executionId, BASH_CHILD_STREAM_PREFIX),
        identity: { kind: 'process', tool: 'bash' },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
        parentExecutionId,
        description: childStreamDescription(command),
      },
    );
    const runWithOwnership = captureOwnedExecutionLease(executionId);

    let childStream!: ChildStream;
    try {
      runWithOwnership(() => {
        childStream = createChildStream(executionId, parentStreamId, {
          streamPrefix: BASH_CHILD_STREAM_PREFIX,
          run: { kind: 'process', tool: 'bash' },
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          description: command,
          config: syntheticConfig,
        });
      });
    } catch (error) {
      throw await releaseOwnedExecutionLeaseAfterFailure(executionId, error);
    }
    const { childStreamId, logger } = childStream;
    // Whitespace normalization is off here: a background log is delivered
    // verbatim, and its head/tail budgets are its own (see the constants
    // above) rather than the foreground tool-result ones.
    const stdout = createBoundedOutputCapture(
      BACKGROUND_OUTPUT_HEAD_CHARS,
      BACKGROUND_OUTPUT_TAIL_CHARS,
      { normalizeWhitespace: false },
    );
    const stderr = createBoundedOutputCapture(
      BACKGROUND_OUTPUT_HEAD_CHARS,
      BACKGROUND_OUTPUT_TAIL_CHARS,
      { normalizeWhitespace: false },
    );
    let loggedChars = 0;
    let logCapReached = false;
    // Capture the run's session inside the tool's ALS; deliverAndFinalize below
    // unregisters after the process ends, possibly outside the ALS.
    const runSession = currentSession();
    const session = new BashBackgroundSession();
    const stopWatchingLease = onOwnedExecutionLeaseLost(executionId, () => {
      logger.error('Execution lease was lost; stopping background command', {
        data: { executionId, childStreamId },
      });
      session.interrupt();
    });
    const detachInterruptHandler =
      runSession.executions
        .getAgentHandleByStream(childStreamId)
        ?.attachInterruptHandler(session) ?? (() => {});

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

    const startedAt = Date.now();
    const promise = Promise.resolve(
      runWithOwnership(() =>
        executeCommand(command, {
          cwd,
          timeout: timeoutMs,
          buffer: false,
          signal: session.signal,
          onStdout: (chunk) => {
            stdout.append(chunk);
            logChunk(chunk, 'info');
          },
          onStderr: (chunk) => {
            stderr.append(chunk);
            logChunk(chunk, 'warn');
          },
        }),
      ),
    );

    const logBackgroundFailure = (action: string, err: unknown): void => {
      logger.error(`Failed to ${action} background bash result`, {
        data: err,
      });
    };
    const logDurabilityFailure = (action: string, err: unknown): void => {
      markOwnedExecutionLeaseUndurable(executionId);
      logBackgroundFailure(action, err);
    };

    const persistReport = async (msg: string): Promise<void> => {
      try {
        await getExecutionStore(executionId).writeReport(msg);
      } catch (err: unknown) {
        logDurabilityFailure('persist report', err);
      }
    };

    let childFinalized = false;
    const finalizeChild = async (
      finalizeOptions: Parameters<typeof childStream.finalize>[0],
    ): Promise<void> => {
      // The child is terminal before the continuation is submitted, so a
      // synchronously claimed parent recovery can never observe it as running.
      detachInterruptHandler();
      await childStream.finalize(finalizeOptions);
      childFinalized = true;
    };

    const deliverAndFinalize = async (
      text: string,
      finalizeOptions: Parameters<typeof childStream.finalize>[0],
    ): Promise<void> => {
      await finalizeChild(finalizeOptions);
      try {
        const delivery = await deliverChildRunFollowUp({
          targetStreamId: parentStreamId,
          followUp: { text, origin: 'subagent_result' },
          session: runSession,
        });
        if (delivery.kind !== 'delivered') {
          logger.warn(
            'Background bash follow-up dropped: parent stream is unavailable.',
            { data: { parentStreamId } },
          );
        }
      } catch (err: unknown) {
        logBackgroundFailure('delivery', err);
      }
    };

    void runWithOwnership(async () => {
      try {
        const outcome = await promise.then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        if (outcome.ok) {
          const { result } = outcome;
          const wallTimeMs = Date.now() - startedAt;
          const error = result.success
            ? undefined
            : new ToolError(
                `Background bash failed with exit code ${result.exitCode ?? 'unknown'}.`,
              );

          const msg = formatBashDelivery(
            executionId,
            command,
            wallTimeMs,
            result,
            toDeliveryExcerpt(stdout),
            toDeliveryExcerpt(stderr),
          );

          const store = getExecutionStore(executionId);
          try {
            await store.writeResultMeta({
              producer: 'backgroundBash',
              exitCode: result.exitCode ?? (result.success ? 0 : 1),
              wallTimeMs,
              success: result.success,
              timedOut: result.timedOut ?? false,
              command,
            });
          } catch (err: unknown) {
            logDurabilityFailure('persist result metadata', err);
          }
          await persistReport(msg);

          await deliverAndFinalize(msg, {
            wallTimeMs,
            outcome: error ? { kind: 'failed', error } : { kind: 'completed' },
            persistence: BACKGROUND_TERMINAL_PERSISTENCE,
            autoClose: true,
          });
          return;
        }

        const { error } = outcome;
        const msg = formatBashError(executionId, command, error);
        await persistReport(msg);

        await deliverAndFinalize(msg, {
          outcome: { kind: 'failed', error },
          persistence: BACKGROUND_TERMINAL_PERSISTENCE,
          autoClose: true,
        });
      } catch (err: unknown) {
        logDurabilityFailure('complete', err);
        // Nothing else finalizes a background child, so an unexpected throw
        // before the normal finalize would leave the stream RUNNING forever
        // and its interrupt handler attached to a dead process.
        if (!childFinalized) {
          try {
            await finalizeChild({
              outcome: { kind: 'failed', error: err },
              persistence: BACKGROUND_TERMINAL_PERSISTENCE,
              autoClose: true,
            });
          } catch (finalizeError: unknown) {
            logBackgroundFailure('finalize after failure', finalizeError);
          }
        }
      } finally {
        try {
          await releaseExecutionLeaseAfterArtifacts(runSession, executionId);
        } catch (err: unknown) {
          logBackgroundFailure('persist final artifacts', err);
        } finally {
          stopWatchingLease();
        }
      }
    });

    return executed(
      [
        `Command launched in background.`,
        `Execution ID: ${executionId}`,
        `Stream tab: ${childStreamId}`,
        'Result arrives automatically as a follow-up message when complete. Continue other work or end your turn.',
        `To read its output so far (works while it runs): executions tool with path=/executions/${executionId}/output`,
        `Only if you cannot proceed without the result, block with the executions tool: path=/executions/${executionId} action=wait`,
      ].join('\n'),
      `Launched background: ${preview}`,
    );
  }
}
