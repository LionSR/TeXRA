/**
 * Codex tool — spin off an OpenAI Codex agent via the @openai/codex-sdk.
 *
 * Supports foreground (blocking) and background (async follow-up) modes,
 * mirroring the BashTool pattern. The Codex CLI handles its own auth
 * (~/.codex/auth.json from `codex login`, OPENAI_API_KEY, config files).
 *
 * Requires the Codex CLI binary — gated by the availability check in
 * externalToolDefs.ts.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  getExecutionStore,
  registerExecution,
  writeTerminalStatus,
} from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  trackExecution,
  untrackExecution,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId, ExecutionId } from '@shared/schemas';
import { MESSAGE_TYPES, STREAM_STATUS } from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { escapeAttr, escapeText } from '@tools/subagentResults';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { formatDuration } from '@utils/core';
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { importCodexClass, findCodexBinaryPath } from './codexImport';

// Type-only imports (kept separate for bundler efficiency)
import type {
  RunResult,
  SandboxMode,
  Thread,
  ThreadItem,
} from '@openai/codex-sdk';

// ============================================================================
// Schema
// ============================================================================

/** All sandbox modes from the SDK, exposed to the LLM. */
const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const satisfies readonly SandboxMode[];

const CodexInputSchema = z.strictObject({
  prompt: z.string().describe('Instruction for the Codex agent'),
  working_directory: z
    .string()
    .optional()
    .describe('Directory to run in (defaults to workspace root)'),
  sandbox_mode: z
    .enum(SANDBOX_MODES)
    .prefault('read-only')
    .describe('File access level for the Codex agent'),
  run_in_background: z
    .boolean()
    .prefault(false)
    .describe(
      'Run asynchronously. Returns immediately with execution ID. Result delivered as follow-up when complete.',
    ),
});

export type CodexInput = z.infer<typeof CodexInputSchema>;

// ============================================================================
// Result formatting
// ============================================================================

/**
 * Format a completed Codex turn for the tool result returned to the LLM.
 *
 * Only includes the final model response (what the LLM needs to act on) plus
 * a compact usage note. Intermediate details (commands run, files changed) are
 * streamed to the child stream tab and don't need to be in the result.
 */
function formatTurnResult(turn: RunResult): string {
  const parts: string[] = [turn.finalResponse || '(no response)'];

  if (turn.usage) {
    parts.push(
      `[Tokens: ${turn.usage.input_tokens} in / ${turn.usage.output_tokens} out]`,
    );
  }

  return parts.join('\n\n');
}

/** Format a Codex result for background delivery as XML. */
function formatCodexDelivery(
  executionId: string,
  prompt: string,
  wallTimeMs: number,
  turn: RunResult,
): string {
  const durationSec = (wallTimeMs / 1000).toFixed(1);
  const response = turn.finalResponse || '(no response)';
  const lines = [
    `<codex-result id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}">`,
    `<wall-time>${durationSec}s</wall-time>`,
    `<response>${escapeText(response)}</response>`,
  ];

  if (turn.usage) {
    lines.push(
      `<usage input="${turn.usage.input_tokens}" output="${turn.usage.output_tokens}" />`,
    );
  }

  lines.push('</codex-result>');
  return lines.join('\n');
}

/** Format a Codex error for background delivery. */
function formatCodexError(
  executionId: string,
  prompt: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `<codex-error id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}">`,
    `<message>${escapeText(message)}</message>`,
    '</codex-error>',
  ].join('\n');
}

// ============================================================================
// Stream tab helpers
// ============================================================================

/** Create a child stream tab for a codex execution and return its logger. */
function createCodexStream(
  executionId: string,
  parentStreamId: StreamTabId,
  prompt: string,
): { childStreamId: StreamTabId; logger: AgentLogger } {
  const childStreamId = `codex@codex-sdk#${executionId}` as StreamTabId;

  StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING);
  bus.emit('setActiveStream', {
    streamId: childStreamId,
    agentCategory: AgentCategory.ToolUse,
  });
  bus.emit('updateStreamDescription', {
    streamId: childStreamId,
    description: truncateWithEllipsis(prompt, 80),
  });

  const logger = new AgentLogger(childStreamId, true);
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    'codex',
    'toolUse',
  );
  trackExecution(handle);

  return { childStreamId, logger };
}

/** Log a completed codex thread item to the child stream's logger. */
function logCodexItem(
  item: ThreadItem,
  logger: AgentLogger,
): void {
  switch (item.type) {
    case 'command_execution': {
      const exitInfo =
        item.exit_code === undefined
          ? item.status
          : item.exit_code === 0
            ? 'ok'
            : `exit ${item.exit_code}`;
      logger.logToolUse({
        toolName: 'bash',
        input: { command: item.command },
        output: `(${exitInfo})`,
        status: 'completed',
      });
      break;
    }
    case 'file_change': {
      const changes = item.changes.map((c: { kind: string; path: string }) => `${c.kind} ${c.path}`);
      if (changes.length > 0) {
        logger.info(`Files: ${changes.join(', ')}`);
      }
      break;
    }
    case 'agent_message':
      logger.info(item.text, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
      break;
    case 'reasoning':
      logger.info(item.text, { messageType: MESSAGE_TYPES.THINKING });
      break;
    case 'error':
      logger.error(item.message);
      break;
  }
}

/** Finalize a codex child stream (mark ready, log summary). */
function finalizeCodexStream(
  childStreamId: StreamTabId,
  executionId: string,
  logger: AgentLogger,
  options?: { wallTimeMs?: number; usage?: RunResult['usage']; error?: unknown },
): void {
  if (options?.error) {
    const msg =
      options.error instanceof Error
        ? options.error.message
        : String(options.error);
    logger.error(msg);
  }
  if (options?.wallTimeMs != null) {
    logger.info(`Completed in ${formatDuration(options.wallTimeMs)}`);
  }
  if (options?.usage) {
    logger.info(
      `Tokens: ${options.usage.input_tokens} in / ${options.usage.output_tokens} out`,
    );
  }
  StreamStatusService.set(childStreamId, STREAM_STATUS.READY);
  untrackExecution(executionId);
}

// ============================================================================
// Tool
// ============================================================================

export class CodexTool extends defineTool({
  name: 'codex',
  description:
    'Spin off an OpenAI Codex agent to perform code analysis, generation, or research in a sandboxed environment. ' +
    'The agent runs the Codex CLI locally and can read files, run commands, and make edits within its sandbox. ' +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself — use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var.',
  schema: CodexInputSchema,
}) {
  protected async execute(input: CodexInput): Promise<ToolResult> {
    // Request approval — same pattern as BashTool
    const approvalLabel = `[codex ${input.sandbox_mode}] ${input.prompt}`;
    const approval = await requestBashApproval({ command: approvalLabel });
    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(
        approvalLabel,
        approval.userMessage,
      );
    }

    // Signal execution starting
    const ctx = getCurrentToolFileInteractionContext();
    ctx?.onExecutionReady?.();

    // Dynamic import — resolved at runtime, not bundled (see webpack externals)
    const Codex = await importCodexClass();

    // The SDK resolves the native binary relative to itself, but we don't
    // ship the 130 MB platform binaries in the VSIX. Find the binary from
    // the user's global npm install and pass it via codexPathOverride.
    const codexPathOverride = findCodexBinaryPath();
    const codex = new Codex({ codexPathOverride });
    const thread = codex.startThread({
      workingDirectory: input.working_directory,
      sandboxMode: input.sandbox_mode,
      skipGitRepoCheck: true,
    });

    if (input.run_in_background) {
      return this.executeBackground(
        thread,
        input,
        ctx?.streamId,
        ctx?.executionId,
      );
    }

    return this.executeForeground(thread, input, ctx?.streamId);
  }

  private async executeForeground(
    thread: Thread,
    input: CodexInput,
    parentStreamId?: StreamTabId,
  ): Promise<ToolResult> {
    const executionId = generateExecutionId();
    const preview = truncateWithEllipsis(input.prompt, 60);
    const startedAt = Date.now();

    const stream = parentStreamId
      ? createCodexStream(executionId, parentStreamId, input.prompt)
      : undefined;

    try {
      const turn = await this.runStreamedForeground(
        thread,
        input,
        stream?.logger,
      );

      if (stream) {
        finalizeCodexStream(stream.childStreamId, executionId, stream.logger, {
          wallTimeMs: Date.now() - startedAt,
          usage: turn.usage,
        });
      }

      return {
        summary: `Codex: ${preview}`,
        output: formatTurnResult(turn),
      };
    } catch (err) {
      if (stream) {
        finalizeCodexStream(stream.childStreamId, executionId, stream.logger, {
          error: err,
        });
      }
      throw err;
    }
  }

  /** Run a foreground turn via the streaming API, logging events to the child stream. */
  private async runStreamedForeground(
    thread: Thread,
    input: CodexInput,
    logger?: AgentLogger,
  ): Promise<RunResult> {
    const { events } = await thread.runStreamed(input.prompt);
    const responseParts: string[] = [];
    let usage: RunResult['usage'] = null;

    for await (const event of events) {
      switch (event.type) {
        case 'item.completed': {
          const { item } = event;
          if (logger) {
            logCodexItem(item, logger);
          }
          if (item.type === 'agent_message') {
            responseParts.push(item.text);
          }
          break;
        }
        case 'turn.completed':
          usage = event.usage ?? null;
          break;
        case 'turn.failed':
          throw new ToolError(event.error.message ?? 'Codex turn failed');
        case 'error':
          throw new ToolError(event.message ?? 'Codex stream error');
      }
    }

    return {
      items: [],
      finalResponse: responseParts.join('\n\n'),
      usage,
    };
  }

  private async executeBackground(
    thread: Thread,
    input: CodexInput,
    parentStreamId: StreamTabId | undefined,
    parentExecutionId: ExecutionId | undefined,
  ): Promise<ToolResult> {
    if (!parentStreamId) {
      throw new ToolError(
        'Background execution requires a parent stream context.',
      );
    }

    const executionId = generateExecutionId();
    await ensureRunDir(executionId);

    const preview = truncateWithEllipsis(input.prompt, 60);

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'codex',
      instruction: input.prompt,
    });

    try {
      await registerExecution(
        executionId,
        syntheticConfig,
        'codex',
        parentExecutionId,
      );
    } catch {
      throw new ToolError('Failed to register background Codex execution.');
    }

    const { childStreamId, logger } = createCodexStream(
      executionId,
      parentStreamId,
      input.prompt,
    );

    const startedAt = Date.now();

    const promise = (async (): Promise<RunResult> => {
      const { events } = await thread.runStreamed(input.prompt);
      const responseParts: string[] = [];
      let usage: RunResult['usage'] = null;

      for await (const event of events) {
        switch (event.type) {
          case 'item.completed': {
            const { item } = event;
            logCodexItem(item, logger);
            if (item.type === 'agent_message') {
              responseParts.push(item.text);
            }
            break;
          }
          case 'turn.completed':
            usage = event.usage ?? null;
            break;
          case 'turn.failed': {
            const msg = event.error.message ?? 'Codex turn failed';
            logger.error(msg);
            throw new Error(msg);
          }
          case 'error': {
            const msg = event.message ?? 'Codex stream error';
            logger.error(msg);
            throw new Error(msg);
          }
        }
      }

      return {
        items: [],
        finalResponse: responseParts.join('\n\n'),
        usage,
      };
    })();

    void promise
      .then(async (turn) => {
        const wallTimeMs = Date.now() - startedAt;
        const store = getExecutionStore(executionId);

        await writeTerminalStatus(executionId, 'completed').catch(() => {});

        finalizeCodexStream(childStreamId, executionId, logger, {
          wallTimeMs,
          usage: turn.usage,
        });

        const msg = formatCodexDelivery(
          executionId,
          input.prompt,
          wallTimeMs,
          turn,
        );
        await store.writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      })
      .catch(async (err: unknown) => {
        await writeTerminalStatus(executionId, 'error').catch(() => {});

        finalizeCodexStream(childStreamId, executionId, logger, { error: err });

        const msg = formatCodexError(executionId, input.prompt, err);
        await getExecutionStore(executionId).writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      });

    return {
      summary: `Launched Codex: ${preview}`,
      output: [
        `Codex agent launched in background (${input.sandbox_mode}).`,
        `Execution ID: ${executionId}`,
        `Stream tab: ${childStreamId}`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
