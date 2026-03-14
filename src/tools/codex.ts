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

// Node builtins
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Codex SDK types — defined locally to avoid a static import of the optional
// @openai/codex-sdk package, which is ESM-only and breaks webpack CJS builds.
// These mirror the canonical types from @openai/codex-sdk/dist/index.d.ts.
// ---------------------------------------------------------------------------

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

// -- Thread items (discriminated union) ------------------------------------

type CommandExecutionItem = {
  id: string;
  type: 'command_execution';
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: 'in_progress' | 'completed' | 'failed';
};

type FileUpdateChange = { path: string; kind: 'add' | 'delete' | 'update' };

type FileChangeItem = {
  id: string;
  type: 'file_change';
  changes: FileUpdateChange[];
  status: 'completed' | 'failed';
};

type AgentMessageItem = {
  id: string;
  type: 'agent_message';
  text: string;
};

type ReasoningItem = {
  id: string;
  type: 'reasoning';
  text: string;
};

type ErrorItem = {
  id: string;
  type: 'error';
  message: string;
};

// We only need to discriminate on types we handle; the rest share a common shape.
type OtherItem = {
  id: string;
  type: 'web_search' | 'mcp_tool_call' | 'todo_list';
};

type ThreadItem =
  | CommandExecutionItem
  | FileChangeItem
  | AgentMessageItem
  | ReasoningItem
  | ErrorItem
  | OtherItem;

// -- Usage -----------------------------------------------------------------

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
};

// -- Turn / RunResult ------------------------------------------------------

type Turn = {
  items: ThreadItem[];
  finalResponse: string;
  usage: Usage | null;
};

type RunResult = Turn;

// -- Thread ----------------------------------------------------------------

interface Thread {
  run(prompt: string): Promise<RunResult>;
  runStreamed(
    prompt: string,
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

// -- Events (discriminated union) ------------------------------------------

type ItemCompletedEvent = { type: 'item.completed'; item: ThreadItem };
type TurnCompletedEvent = { type: 'turn.completed'; usage: Usage };
type TurnFailedEvent = { type: 'turn.failed'; error: { message: string } };
type ThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | TurnCompletedEvent
  | TurnFailedEvent
  | { type: 'item.started'; item: ThreadItem }
  | { type: 'item.updated'; item: ThreadItem }
  | ItemCompletedEvent
  | { type: 'error'; message: string };

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
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { importCodexClass, findCodexBinaryPath } from './codexImport';

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
 * streamed to the UI via onToolOutput and don't need to be in the result.
 */
function formatTurnResult(turn: RunResult): string {
  const parts: string[] = [];

  if (turn.finalResponse) {
    parts.push(turn.finalResponse);
  } else {
    parts.push('(no response)');
  }

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

/** Format a completed thread item as a human-readable log line for the process view. */
function formatItemForLog(item: ThreadItem): string {
  switch (item.type) {
    case 'command_execution': {
      const status =
        item.exit_code === undefined
          ? item.status
          : item.exit_code === 0
            ? 'ok'
            : `exit ${item.exit_code}`;
      return `$ ${item.command} (${status})\n`;
    }
    case 'file_change': {
      const changed = item.changes
        .map((c) => `${c.kind} ${c.path}`)
        .join(', ');
      return changed ? `Files: ${changed}\n` : '';
    }
    case 'agent_message':
      return `${item.text}\n`;
    case 'reasoning':
      return `[reasoning] ${item.text}\n`;
    case 'error':
      return `Error: ${item.message}\n`;
    default:
      return '';
  }
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

    return this.executeForeground(thread, input, ctx?.onToolOutput);
  }

  private async executeForeground(
    thread: Thread,
    input: CodexInput,
    onToolOutput?: (chunk: string) => void,
  ): Promise<ToolResult> {
    // Use streaming path when the framework provides a live-output callback,
    // so partial results appear in the UI as they arrive (like slow bash).
    const turn = onToolOutput
      ? await this.runStreamedForeground(thread, input, onToolOutput)
      : await thread.run(input.prompt);

    const preview = truncateWithEllipsis(input.prompt, 60);

    return {
      summary: `Codex: ${preview}`,
      output: formatTurnResult(turn),
    };
  }

  /** Run a foreground turn via the streaming API, pushing chunks to the UI. */
  private async runStreamedForeground(
    thread: Thread,
    input: CodexInput,
    onToolOutput: (chunk: string) => void,
  ): Promise<RunResult> {
    const { events } = await thread.runStreamed(input.prompt);
    const items: ThreadItem[] = [];
    const responseParts: string[] = [];
    let usage: RunResult['usage'] = null;

    for await (const event of events) {
      switch (event.type) {
        case 'item.completed': {
          const { item } = event;
          items.push(item);
          const line = formatItemForLog(item);
          if (line) onToolOutput(line);
          if (item.type === 'agent_message') {
            responseParts.push(item.text);
          }
          break;
        }
        case 'turn.completed':
          usage = event.usage ?? null;
          break;
        case 'turn.failed':
          throw new ToolError(
            event.error.message ?? 'Codex turn failed',
          );
        case 'error':
          throw new ToolError(
            event.message ?? 'Codex stream error',
          );
      }
    }

    return {
      items,
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

    // Temp file for live output — the execution registry poller reads this
    // incrementally and surfaces it in the clickable process view.
    const stdoutPath = path.join(
      os.tmpdir(),
      `texra-bg-${executionId}-stdout.log`,
    );
    const stderrPath = path.join(
      os.tmpdir(),
      `texra-bg-${executionId}-stderr.log`,
    );
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' });
    stdoutStream.on('error', () => {}); // prevent unhandled emitter crash
    stderrStream.on('error', () => {});

    const handle = new ProcessExecutionHandle(
      executionId,
      parentStreamId,
      preview,
      () => false, // Codex SDK doesn't expose PID for kill — AbortController would be future work
    );
    handle.outputPaths = { stdout: stdoutPath, stderr: stderrPath };

    try {
      await registerExecution(
        executionId,
        syntheticConfig,
        'codex',
        parentExecutionId,
        'process',
      );
    } catch {
      stdoutStream.end();
      stderrStream.end();
      void fs.promises.unlink(stdoutPath).catch(() => {});
      void fs.promises.unlink(stderrPath).catch(() => {});
      throw new ToolError('Failed to register background Codex execution.');
    }

    trackExecution(handle);

    const startedAt = Date.now();

    const cleanupTempFiles = (): void => {
      stdoutStream.end();
      stderrStream.end();
      handle.outputPaths = undefined;
      void fs.promises.unlink(stdoutPath).catch(() => {});
      void fs.promises.unlink(stderrPath).catch(() => {});
    };

    const promise = (async (): Promise<RunResult> => {
      const { events } = await thread.runStreamed(input.prompt);
      const responseParts: string[] = [];
      let usage: RunResult['usage'] = null;

      for await (const event of events) {
        switch (event.type) {
          case 'item.completed': {
            const { item } = event;
            const line = formatItemForLog(item);
            if (line) stdoutStream.write(line);
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
            stderrStream.write(`Error: ${msg}\n`);
            throw new Error(msg);
          }
          case 'error': {
            const msg = event.message ?? 'Codex stream error';
            stderrStream.write(`Error: ${msg}\n`);
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

        const msg = formatCodexError(executionId, input.prompt, err);
        await getExecutionStore(executionId).writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      })
      .finally(() => {
        untrackExecution(executionId);
        cleanupTempFiles();
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
