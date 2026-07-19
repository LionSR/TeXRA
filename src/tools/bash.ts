// Third-party imports
import { z } from 'zod';

// Local imports - platform

// Local imports - agent
import {
  finalizeExecution,
  getExecutionStore,
  registerExecution,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage';
import {
  markOwnedExecutionLeaseUndurable,
  onOwnedExecutionLeaseLost,
} from '@agent/storage/executionLease';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  getCurrentToolContexts,
  type ToolCallContext,
} from '@agent/followUp/ToolFileInteractionContext';
import type { ExecutionInterruptHandler } from '@agent/runtime/ExecutionHandle';
import {
  getRunContextExecutionId,
  getRunContextWorkingDirectory,
} from '@agent/runtime/RunContext';
import { currentSession } from '@agent/runtime/SessionHandle';
import { releaseExecutionLeaseAfterArtifacts } from '@agent/runtime/executionOwnership';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

// Local imports - tools

// Local imports - utils
import { tryPlatform } from '@platform/platform';
import { BASH_TOOL_DEFAULT_TIMEOUT_MS } from '@shared/toolUse';
import { type StreamTabId, type ExecutionId } from '@shared/schemas';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import {
  deriveRunOutcome,
  projectRunOutcome,
} from '@shared/streams/streamStatus';
import {
  enqueueChildRunFollowUp,
  wakeChildRunFollowUp,
  type ChildRunEnqueueResult,
} from '@tools/childRunDelivery';
import { requireRunStream } from '@tools/contextHelpers';
import {
  formatBashDelivery,
  formatBashError,
  type BashDeliveryStreamExcerpt,
} from '@tools/subagentResults';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { formatDuration, generateExecutionId } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { executeCommand, signalProcessGroup } from '@utils/system/execUtils';
import { appendHead, appendTail } from '@utils/strings/appendTail';

// Local file imports
import { defineTool } from './core/define';
import { createChildStream } from './childStream';
import { parseWorkingDirectory } from './pathResolution';

const BACKGROUND_OUTPUT_TAIL_CHARS = 12_000;
/**
 * Small head budget retained alongside the tail (approximates the foreground
 * checkToolResultTextLimit head:tail ratio of TOOL_RESULT_TRUNCATION_HEAD_CHARS
 * /_TAIL_CHARS, 4,000/50,000 = 8.0% — this is 1,000/12,000 ≈ 8.3%, close but
 * not identical, since the two paths have independently-sized tail budgets).
 * A long background build's first fatal error tends to sit near the top of
 * the log, well before the tail budget's trailing window; without this,
 * output that outgrows the tail silently drops that error with no way to
 * recover it from the follow-up.
 */
const BACKGROUND_OUTPUT_HEAD_CHARS = 1_000;
/** Max chars logged to the child stream tab to prevent unbounded memory growth. */
const BACKGROUND_LOG_CAP_CHARS = 200_000;
const SHELL_BACKGROUNDING_PATTERN =
  /(?:^|[\s;])nohup\b[^\n;]*(?<![>&])&(?![>&])/;
const SHELL_BACKGROUNDING_MESSAGE =
  'This command uses shell-level backgrounding (`nohup ... &`) inside a foreground bash tool call. ' +
  'Do not emulate background execution inside the shell; call the bash tool again with `run_in_background: true` and the command without `nohup` or a trailing `&`.';

function backgroundBashTerminalStatus(success: boolean) {
  return projectRunOutcome(
    deriveRunOutcome({ failed: !success, cancelled: false }),
  ).executionStatus;
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
      'Run command in background. Returns immediately with execution ID and child stream tab. Result delivered as follow-up when complete.',
    ),
});

export type BashInput = z.infer<typeof BashInputSchema>;

function usesShellLevelBackgrounding(command: string): boolean {
  return SHELL_BACKGROUNDING_PATTERN.test(command);
}

class BashBackgroundSession implements ExecutionInterruptHandler {
  /** Shutdown drain reaches this handler via `interruptBackgroundProcess()`. */
  readonly ownsBackgroundProcess = true;
  private pid: number | undefined;
  private interrupted = false;

  setPid(pid: number): void {
    this.pid = pid;
    // If interrupt() was called before pid arrived, kill now
    if (this.interrupted) {
      signalProcessGroup(pid, 'SIGTERM');
    }
  }

  interrupt(): void {
    this.interrupted = true;
    if (this.pid) {
      signalProcessGroup(this.pid, 'SIGTERM');
    }
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
      usesShellLevelBackgrounding(input.command)
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

    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(
        input.command,
        approval.userMessage,
        approval.timedOut,
      );
    }

    // Signal execution starting (triggers in-progress log after approval)
    callContext?.hooks?.onExecutionReady?.();

    const timeoutMs = input.timeout ?? BASH_TOOL_DEFAULT_TIMEOUT_MS;

    if (input.run_in_background) {
      const { streamId, runtimeHost } = requireRunStream(
        'bash run_in_background',
        runContext,
      );
      return this.executeBackground(
        input.command,
        timeoutMs,
        streamId,
        getRunContextExecutionId(runContext),
        runtimeHost,
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
    const startedAt = Date.now();
    const result = await executeCommand(command, {
      cwd,
      truncate: true,
      timeout: timeoutMs,
      onStdout: ctx?.hooks?.onToolOutput,
      onStderr: ctx?.hooks?.onToolOutput,
      signal: ctx?.signal,
    });

    if (result.timedOut) {
      const parts: string[] = [
        `Foreground command timed out after ${timeoutMs / 1000}s.`,
      ];
      if (result.stdout) parts.push(`<stdout>${result.stdout}</stdout>`);
      if (result.stderr) parts.push(`<stderr>${result.stderr}</stderr>`);
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
      return {
        status: 'executed',
        summary: `Executed: ${preview} (exit 0, ${duration})`,
        output: result.stdout ?? '',
      };
    }
    // Many CLI tools (including latexmk) write errors to stdout, not stderr
    const errorOutput =
      [result.stderr, result.stdout].filter(Boolean).join('\n') ||
      'No error output available';
    throw new ToolError(`Command failed (${duration}): ${errorOutput}`);
  }

  private async executeBackground(
    command: string,
    timeoutMs: number,
    parentStreamId: StreamTabId,
    parentExecutionId: ExecutionId | undefined,
    runtimeHost: AgentRuntimeHost,
    cwd?: string,
  ): Promise<ToolResult> {
    const executionId = generateExecutionId();

    const preview = truncateWithEllipsis(command, 60);

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'bash',
      instruction: command,
      agentCategory: AgentCategory.ToolUse,
    });

    await registerExecution(
      executionId,
      syntheticConfig,
      'bash',
      parentExecutionId,
      'process',
    );

    let childStream: ReturnType<typeof createChildStream>;
    try {
      childStream = createChildStream(executionId, parentStreamId, {
        streamPrefix: 'bash@tool',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'bash',
        description: command,
        config: syntheticConfig,
        toolName: 'bash',
        runtimeHost,
      });
    } catch (error) {
      throw await releaseOwnedExecutionLeaseAfterFailure(executionId, error);
    }
    const { childStreamId, logger } = childStream;
    let stdoutTail = '';
    let stderrTail = '';
    let stdoutHead = '';
    let stderrHead = '';
    let stdoutTotalChars = 0;
    let stderrTotalChars = 0;
    let loggedChars = 0;
    let logCapReached = false;
    // Capture the run's session inside the tool's ALS; finalizeBackground below
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
      if (loggedChars > BACKGROUND_LOG_CAP_CHARS) {
        logCapReached = true;
        logger.warn(
          `[Stream log truncated at ${(BACKGROUND_LOG_CAP_CHARS / 1000).toFixed(0)}k chars — tail available in follow-up result]`,
        );
        return;
      }
      logger[level](chunk);
    };

    const startedAt = Date.now();
    const promise = executeCommand(command, {
      cwd,
      timeout: timeoutMs,
      buffer: false,
      onPid: (p) => {
        session.setPid(p);
      },
      onStdout: (chunk) => {
        stdoutTotalChars += chunk.length;
        stdoutHead = appendHead(
          stdoutHead,
          chunk,
          BACKGROUND_OUTPUT_HEAD_CHARS,
        );
        stdoutTail = appendTail(
          stdoutTail,
          chunk,
          BACKGROUND_OUTPUT_TAIL_CHARS,
        );
        logChunk(chunk, 'info');
      },
      onStderr: (chunk) => {
        stderrTotalChars += chunk.length;
        stderrHead = appendHead(
          stderrHead,
          chunk,
          BACKGROUND_OUTPUT_HEAD_CHARS,
        );
        stderrTail = appendTail(
          stderrTail,
          chunk,
          BACKGROUND_OUTPUT_TAIL_CHARS,
        );
        logChunk(chunk, 'warn');
      },
    });

    const finalizeBackground = (
      options?: Parameters<typeof childStream.finalize>[0],
    ): Promise<void> => {
      detachInterruptHandler();
      return childStream.finalize(options);
    };

    const logBackgroundFailure = (action: string, err: unknown): void => {
      logger.error(`Failed to ${action} background bash result`, {
        data: err,
      });
    };
    const logDurabilityFailure = (action: string, err: unknown): void => {
      markOwnedExecutionLeaseUndurable(executionId);
      logBackgroundFailure(action, err);
    };

    const finalizeAndReport = async (
      success: boolean,
      msg: string,
    ): Promise<void> => {
      try {
        const finalization = await finalizeExecution({
          executionId,
          terminalStatus: backgroundBashTerminalStatus(success),
          flowRecord: 'delete',
        });
        if (finalization.status === 'failed') throw finalization.error;
      } catch (err: unknown) {
        logDurabilityFailure('finalize execution', err);
      }
      try {
        await getExecutionStore(executionId).writeReport(msg);
      } catch (err: unknown) {
        logDurabilityFailure('persist report', err);
      }
    };

    const enqueueParentFollowUp = async (
      text: string,
    ): Promise<ChildRunEnqueueResult | undefined> => {
      try {
        return await enqueueChildRunFollowUp({
          targetStreamId: parentStreamId,
          followUp: { text, origin: 'subagent_result' },
          session: runSession,
        });
      } catch (err: unknown) {
        logBackgroundFailure('enqueue', err);
        return undefined;
      }
    };

    // Wake the parent only after this child is finalized (see #8093): waking
    // a WAITING parent can await its entire resumed turn
    // (`agentResume.tryResumeStream` → … → `resumeToolUseFromResumeData`), and
    // that resumed turn may itself wait on this execution — so finalizing
    // first keeps a self-stall impossible instead of merely unlikely.
    const wakeParentFollowUp = async (
      enqueueResult: ChildRunEnqueueResult | undefined,
    ): Promise<void> => {
      if (!enqueueResult) return;
      if (enqueueResult.kind === 'no_session') {
        logger.debug(
          'Background bash follow-up dropped: parent stream has no active session.',
          {
            data: {
              parentStreamId,
              streamStatus: enqueueResult.streamStatus ?? 'unknown',
            },
          },
        );
        return;
      }
      try {
        const delivery = await wakeChildRunFollowUp(
          parentStreamId,
          enqueueResult,
          runSession,
        );
        if (delivery.kind === 'dropped') {
          logger.warn(
            'Background bash follow-up dropped: parent stream is gone and could not be resumed.',
            { data: { parentStreamId } },
          );
        }
      } catch (err: unknown) {
        logBackgroundFailure('wake', err);
      }
    };

    const deliverAndFinalize = async (
      text: string,
      finalizeOptions: Parameters<typeof finalizeBackground>[0],
    ): Promise<void> => {
      // Order matters (see #8093): enqueue the result (fast), finalize this
      // child so its terminal state is visible in the in-memory execution
      // registry, then wake the parent — never the other way around.
      const enqueueResult = await enqueueParentFollowUp(text);
      await finalizeBackground(finalizeOptions);
      await wakeParentFollowUp(enqueueResult);
    };

    void (async () => {
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

          // Only surface the head when the tail actually dropped earlier
          // content — otherwise the tail already holds the full stream and a
          // separate head block would just repeat it. When it did, also
          // report how many characters sit in the gap between head and tail,
          // mirroring the foreground `checkToolResultTextLimit` elision note.
          const stdoutTruncated = stdoutTotalChars > stdoutTail.length;
          const stderrTruncated = stderrTotalChars > stderrTail.length;
          const stdoutExcerpt: BashDeliveryStreamExcerpt = {
            tail: stdoutTail,
            head: stdoutTruncated ? stdoutHead : '',
            elidedChars: stdoutTruncated
              ? Math.max(
                  0,
                  stdoutTotalChars - stdoutHead.length - stdoutTail.length,
                )
              : 0,
          };
          const stderrExcerpt: BashDeliveryStreamExcerpt = {
            tail: stderrTail,
            head: stderrTruncated ? stderrHead : '',
            elidedChars: stderrTruncated
              ? Math.max(
                  0,
                  stderrTotalChars - stderrHead.length - stderrTail.length,
                )
              : 0,
          };
          const msg = formatBashDelivery(
            executionId,
            command,
            wallTimeMs,
            result,
            stdoutExcerpt,
            stderrExcerpt,
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
          await finalizeAndReport(result.success, msg);

          await deliverAndFinalize(msg, {
            wallTimeMs,
            outcome: error ? { kind: 'failed', error } : { kind: 'completed' },
            autoClose: true,
          });
          return;
        }

        const { error } = outcome;
        const msg = formatBashError(executionId, command, error);
        await finalizeAndReport(false, msg);

        await deliverAndFinalize(msg, {
          outcome: { kind: 'failed', error },
          autoClose: true,
        });
      } catch (err: unknown) {
        logDurabilityFailure('complete', err);
      } finally {
        try {
          await releaseExecutionLeaseAfterArtifacts(runSession, executionId);
        } catch (err: unknown) {
          logBackgroundFailure('persist final artifacts', err);
        } finally {
          stopWatchingLease();
        }
      }
    })();

    return {
      status: 'executed',
      summary: `Launched background: ${preview}`,
      output: [
        `Command launched in background.`,
        `Execution ID: ${executionId}`,
        `Stream tab: ${childStreamId}`,
        `To wait for completion: executions tool with path=/executions/${executionId} action=wait`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
