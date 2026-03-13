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
import type {
  RunResult,
  SandboxMode,
  ThreadItem,
  Thread,
} from '@openai/codex-sdk';

// Local imports - agent
import {
  getExecutionStore,
  registerExecution,
  writeTerminalStatus,
} from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  trackExecution,
  untrackExecution,
  ProcessExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';

// Local imports - tools
import type { StreamTabId, ExecutionId } from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { escapeAttr, escapeText } from '@tools/subagentResults';

// Local imports - utils
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';

// Local file imports
import { defineTool } from './core/define';

// ============================================================================
// Schema
// ============================================================================

/** Sandbox modes exposed to the LLM (excludes danger-full-access intentionally). */
const SANDBOX_MODES = ['read-only', 'workspace-write'] as const satisfies
  readonly SandboxMode[];

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

/** Extract file change summaries from a list of thread items. */
function collectFileChanges(
  items: readonly ThreadItem[],
): { kind: string; path: string }[] {
  return items
    .filter(
      (i): i is ThreadItem & { type: 'file_change' } =>
        i.type === 'file_change',
    )
    .flatMap((i) => i.changes);
}

/** Format a completed Codex turn into a readable string. */
function formatTurnResult(turn: RunResult): string {
  const parts: string[] = [];

  // File changes
  const changes = collectFileChanges(turn.items);
  if (changes.length > 0) {
    parts.push(
      `Files changed: ${changes.map((c) => `${c.kind} ${c.path}`).join(', ')}`,
    );
  }

  // Commands executed
  for (const item of turn.items) {
    if (item.type === 'command_execution') {
      const status = item.exit_code === 0 ? 'ok' : `exit ${item.exit_code}`;
      parts.push(`Command: ${item.command} (${status})`);
    }
  }

  // Final response
  if (turn.finalResponse) {
    parts.push(turn.finalResponse);
  }

  // Usage
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
  ];

  const changes = collectFileChanges(turn.items);
  if (changes.length > 0) {
    lines.push(
      `<files-changed>${escapeText(changes.map((c) => `${c.kind} ${c.path}`).join(', '))}</files-changed>`,
    );
  }

  lines.push(`<response>${escapeText(response)}</response>`);

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
// Tool
// ============================================================================

export class CodexTool extends defineTool({
  name: 'codex',
  description:
    'Spin off an OpenAI Codex agent to perform code analysis, generation, or research in a sandboxed environment. ' +
    'The agent runs the Codex CLI locally and can read files, run commands, and make edits within its sandbox. ' +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself (`codex login` or OPENAI_API_KEY env var).',
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

    // Dynamic import — avoids hard dependency when CLI is not installed
    const { Codex } = await import('@openai/codex-sdk');

    const codex = new Codex();
    const thread = codex.startThread({
      workingDirectory: input.working_directory,
      sandboxMode: input.sandbox_mode,
    });

    if (input.run_in_background) {
      return this.executeBackground(
        thread,
        input,
        ctx?.streamId,
        ctx?.executionId,
      );
    }

    return this.executeForeground(thread, input);
  }

  private async executeForeground(
    thread: Thread,
    input: CodexInput,
  ): Promise<ToolResult> {
    const turn = await thread.run(input.prompt);

    const preview =
      input.prompt.length > 60 ? `${input.prompt.slice(0, 57)}…` : input.prompt;

    return {
      summary: `Codex: ${preview}`,
      output: formatTurnResult(turn),
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

    const preview =
      input.prompt.length > 60 ? `${input.prompt.slice(0, 57)}…` : input.prompt;

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'codex',
      instruction: input.prompt,
    });

    const handle = new ProcessExecutionHandle(
      executionId,
      parentStreamId,
      preview,
      () => false, // Codex SDK doesn't expose PID for kill — AbortController would be future work
    );

    try {
      await registerExecution(
        executionId,
        syntheticConfig,
        'codex',
        parentExecutionId,
        'process',
      );
    } catch {
      throw new ToolError('Failed to register background Codex execution.');
    }

    trackExecution(handle);

    const startedAt = Date.now();

    const promise = (async (): Promise<RunResult> => {
      const { events } = await thread.runStreamed(input.prompt);
      const items: ThreadItem[] = [];
      const responseParts: string[] = [];
      let usage: RunResult['usage'] = null;

      for await (const event of events) {
        if (event.type === 'item.completed') {
          const item = (event as { item: ThreadItem }).item;
          items.push(item);

          // Progress updates for the orchestrator
          if (item.type === 'command_execution') {
            ToolUseFollowUpQueue.enqueue(
              parentStreamId,
              `Running: ${item.command}`,
            );
          } else if (item.type === 'file_change') {
            const changed = item.changes
              .map((c) => `${c.kind} ${c.path}`)
              .join(', ');
            if (changed) {
              ToolUseFollowUpQueue.enqueue(
                parentStreamId,
                `Codex file changes: ${changed}`,
              );
            }
          } else if (item.type === 'agent_message') {
            responseParts.push(item.text);
          }
        } else if (event.type === 'turn.completed') {
          usage = (event as { usage: RunResult['usage'] }).usage ?? null;
        } else if (event.type === 'turn.failed') {
          const msg = (event as { error?: { message: string } }).error?.message;
          throw new Error(msg ?? 'Codex turn failed');
        }
      }

      return {
        items,
        finalResponse: responseParts.join('\n\n'),
        usage,
      };
    })();

    void promise
      .then(async (turn) => {
        const wallTimeMs = Date.now() - startedAt;
        const store = getExecutionStore(executionId);

        await writeTerminalStatus(executionId, 'completed').catch(() => {});
        untrackExecution(executionId);

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
        untrackExecution(executionId);

        const msg = formatCodexError(executionId, input.prompt, err);
        await getExecutionStore(executionId).writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      });

    return {
      summary: `Launched Codex: ${preview}`,
      output: [
        `Codex agent launched in background (${input.sandbox_mode}).`,
        `Execution ID: ${executionId}`,
        `To read output: executions tool with path=/executions/${executionId}/output`,
        `To wait for completion: executions tool with path=/executions/${executionId} action=wait`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
