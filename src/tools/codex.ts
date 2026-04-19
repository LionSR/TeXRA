/**
 * Codex tool — spin off an OpenAI Codex agent via the @openai/codex-sdk.
 *
 * Mirrors the `delegate_agent` model: every call is async. Without a
 * thread_id, a new Codex session is launched and the result is delivered
 * as a follow-up to the parent stream. With a thread_id, the prompt is
 * enqueued as a follow-up instruction to an existing session (errors if
 * the session is still processing — never interrupts a running turn).
 * Each turn's result is delivered back to the parent via the follow-up
 * queue, so the orchestrator sees responses uniformly whether it or the
 * user drove the turn.
 *
 * The Codex CLI handles its own auth (~/.codex/auth.json from `codex login`,
 * OPENAI_API_KEY, config files).
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
import { AgentCategory } from '@agent/core/AgentDataclass';
import { untrackExecution } from '@agent/runtime/executionRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  getInterruptible,
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import { toErrorMessage } from '@common/errors';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId, ExecutionId, StorageKey } from '@shared/schemas';
import { MESSAGE_TYPES, STREAM_STATUS } from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { parseWorkingDirectory } from '@tools/utils';
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
import { createChildStream } from './childStream';
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
} from './codexShared';

// Type-only imports (kept separate for bundler efficiency)
import type {
  McpToolCallItem,
  RunResult,
  SandboxMode,
  Thread,
  ThreadItem,
  TodoListItem,
  WebSearchItem,
} from '@openai/codex-sdk';

// ============================================================================
// Codex config
// ============================================================================

// CODEX_SANDBOX_MODES must be inlined (used at module-level by the schema).
// All other config (model, reasoning, buildCodexConfig, workspace, sandbox
// getter) is lazy-imported from codexConfig.ts at runtime to avoid pulling
// vscode into the module graph — src/tools/ is a VS Code-free zone.

/** All sandbox modes from the SDK, exposed to the LLM. */
const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const satisfies readonly SandboxMode[];

/** Lazy accessor for codexConfig.ts exports (loaded once, cached). */
let _configModule: typeof import('./codexConfig') | null = null;
async function getCodexConfig(): Promise<typeof import('./codexConfig')> {
  return (_configModule ??= await import('./codexConfig'));
}

// ============================================================================
// Schema
// ============================================================================

const CodexInputSchema = z.strictObject({
  prompt: z
    .string()
    .describe(
      'Instruction for the Codex agent. For a new session, describe the task. For a resume (thread_id set), describe the follow-up.',
    ),
  sandbox_mode: z
    .enum(CODEX_SANDBOX_MODES)
    .nullish()
    .describe(
      'File access level for the Codex agent (defaults to user-configured mode, typically workspace-write)',
    ),
  thread_id: z
    .string()
    .nullish()
    .describe(
      'Resume an existing Codex thread with a follow-up instruction. The prompt is enqueued as the next turn; if the thread is currently processing, the call errors — wait for its delivery before resuming.',
    ),
});

export type CodexInput = z.infer<typeof CodexInputSchema>;

// ============================================================================
// Thread registry — keeps threads alive between turns for follow-ups
// ============================================================================

interface ActiveThread {
  thread: Thread;
  childStreamId: StreamTabId;
  executionId: ExecutionId;
}

const threadRegistry = new Map<string, ActiveThread>();

/** Store a thread for multi-turn reuse and persist thread ID to disk. */
function storeThread(threadId: string, entry: ActiveThread): void {
  threadRegistry.set(threadId, entry);
  // Extension reload clears memory but SDK stores sessions on disk —
  // persist the ID so later code can display or cross-reference it.
  void getExecutionStore(entry.executionId)
    .write('codex_thread_id', threadId)
    .catch(() => {});
}

/** Prevents codex streams from remaining in stale WAITING state during reload. */
export function interruptAllCodexSessions(): void {
  for (const { childStreamId } of [...threadRegistry.values()]) {
    getInterruptible(childStreamId)?.interrupt();
  }
}

// ============================================================================
// Codex delivery state — mirrors DelegationTools.activeSubagentDelivery
// ============================================================================

/**
 * `hasDelivered` is true between turns (the loop is WAITING) and false while
 * a turn is in flight. Resume via thread_id refuses when !hasDelivered so the
 * orchestrator can't pile up concurrent prompts on the same thread.
 */
interface CodexDeliveryState {
  hasDelivered: boolean;
}

const activeCodexDelivery = new Map<ExecutionId, CodexDeliveryState>();

// ============================================================================
// Codex follow-up session — IInterruptible only (no ToolUseFlowContext)
// ============================================================================

/**
 * Lightweight interruptible registered with the ToolUseAgentRegistry so the
 * stop button works on codex child streams.
 *
 * Does NOT implement the session duck-type (no `session.appendFollowUp`),
 * which prevents `getToolUseFlowContext()` from matching it — commands like
 * `compactResponse` that access `flowContext.modelHandler` won't crash.
 *
 * Follow-ups route through the WAITING state queue path:
 * `sendFollowUp()` → stream is WAITING → `ToolUseFollowUpQueue.enqueue()`.
 */
class CodexFollowUpSession implements IInterruptible {
  private interrupted = false;
  private queue: FollowUpQueue | null = null;

  interrupt(): void {
    this.interrupted = true;
    this.queue?.cancelWait();
  }

  setQueue(q: FollowUpQueue): void {
    this.queue = q;
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }
}

// ============================================================================
// Result formatting
// ============================================================================

/** Format a Codex result for delivery as XML on the parent's follow-up queue. */
function formatCodexDelivery(
  executionId: string,
  prompt: string,
  wallTimeMs: number,
  turn: RunResult,
  threadId?: string | null,
): string {
  const durationSec = (wallTimeMs / 1000).toFixed(1);
  const response = turn.finalResponse || '(no response)';
  const lines = [
    `<codex-result id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}"${threadId ? ` thread-id="${escapeAttr(threadId)}"` : ''}>`,
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

/** Format a Codex error for delivery on the parent's follow-up queue. */
function formatCodexError(
  executionId: string,
  prompt: string,
  err: unknown,
): string {
  return [
    `<codex-error id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}">`,
    `<message>${escapeText(toErrorMessage(err))}</message>`,
    '</codex-error>',
  ].join('\n');
}

// ============================================================================
// Stream tab helpers
// ============================================================================

/** Log a completed codex thread item to the child stream's logger. */
function logCodexItem(
  item: ThreadItem,
  childStreamId: StreamTabId,
  logger: AgentLogger,
): void {
  switch (item.type) {
    case 'command_execution': {
      logger.logToolUse(buildCodexCommandToolLog(item));
      break;
    }
    case 'file_change': {
      const fileLog = buildCodexFileChangeToolLog(item);
      if (fileLog) {
        logger.logToolUse(fileLog);
      }
      break;
    }
    case 'agent_message':
      logger.info(item.text, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
      break;
    case 'reasoning':
      logger.info(item.text, { messageType: MESSAGE_TYPES.THINKING });
      break;
    case 'mcp_tool_call': {
      logger.logToolUse(buildCodexMcpToolLog(item as McpToolCallItem));
      break;
    }
    case 'web_search':
      logger.logWebSearch({ query: (item as WebSearchItem).query });
      break;
    case 'todo_list': {
      const todos = (item as TodoListItem).items.map((t) => ({
        content: t.text,
        status: t.completed ? ('completed' as const) : ('pending' as const),
        activeForm: t.text,
      }));
      bus.emit('updateTodos', { streamId: childStreamId, todos });
      break;
    }
    case 'error':
      logger.error(item.message);
      break;
  }
}

/** Log a turn summary to the child stream. */
function logTurnSummary(
  logger: AgentLogger,
  wallTimeMs: number,
  usage: RunResult['usage'],
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info(
      `Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`,
    );
  }
}

// ============================================================================
// Streaming helpers
// ============================================================================

/** Run a single streamed turn, logging events to the child stream. */
async function runStreamedTurn(
  thread: Thread,
  prompt: string,
  childStreamId: StreamTabId,
  logger: AgentLogger,
): Promise<RunResult> {
  logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });
  const { events } = await thread.runStreamed(prompt);
  const responseParts: string[] = [];
  let usage: RunResult['usage'] = null;

  for await (const event of events) {
    switch (event.type) {
      case 'item.completed': {
        const { item } = event;
        logCodexItem(item, childStreamId, logger);
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

// ============================================================================
// Codex session loop — one turn per enqueued prompt, delivers to parent
// ============================================================================

/**
 * Run the Codex session loop. The loop processes prompts from the child's
 * follow-up queue one at a time and delivers each turn's result to the
 * parent's follow-up queue. The initial prompt is seeded into the queue so
 * the first turn goes through the same code path as every follow-up turn.
 */
function startCodexLoop(params: {
  thread: Thread;
  childStreamId: StreamTabId;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  logger: AgentLogger;
  initialPrompt: string;
}): void {
  const {
    thread,
    childStreamId,
    parentStreamId,
    executionId,
    logger,
    initialPrompt,
  } = params;

  const session = new CodexFollowUpSession();
  const queue = ToolUseFollowUpQueue.acquire(childStreamId);
  session.setQueue(queue);
  registerInterruptible(childStreamId, session);

  const deliveryState: CodexDeliveryState = { hasDelivered: true };
  activeCodexDelivery.set(executionId, deliveryState);

  // Start a log group so endRunningGroups() marks it as errored on reload,
  // giving the user a visual cue that the session was interrupted.
  const groupId = logger.startGroup('Codex session');

  // Seed the initial prompt; the loop drains it as the first turn.
  queue.enqueue(initialPrompt);
  StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING);

  void (async () => {
    try {
      while (!session.isInterrupted()) {
        const messages = await queue.waitAndDrainAll(() =>
          session.isInterrupted(),
        );
        if (!messages || session.isInterrupted()) break;

        const prompt = messages.join('\n\n');
        deliveryState.hasDelivered = false;
        StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING);
        const startedAt = Date.now();

        let turn: RunResult | null = null;
        let err: unknown = null;
        try {
          turn = await runStreamedTurn(thread, prompt, childStreamId, logger);
          logTurnSummary(logger, Date.now() - startedAt, turn.usage);
        } catch (caught) {
          err = caught;
          logger.error(toErrorMessage(caught));
        }

        const wallTimeMs = Date.now() - startedAt;
        const threadId = thread.id;
        if (threadId && !threadRegistry.has(threadId)) {
          storeThread(threadId, { thread, childStreamId, executionId });
        }

        if (turn?.usage) {
          bus.emit('updateStreamUsage', {
            streamId: childStreamId,
            storageKey: executionId as StorageKey,
            executionId,
            usage: {
              inputTokens: turn.usage.input_tokens,
              outputTokens: turn.usage.output_tokens,
              cost: 0,
            },
          });
        }

        const msg =
          turn && !err
            ? formatCodexDelivery(
                executionId,
                prompt,
                wallTimeMs,
                turn,
                threadId,
              )
            : formatCodexError(executionId, prompt, err);
        try {
          await getExecutionStore(executionId).writeReport(msg);
        } catch {
          // Best-effort; delivery must not block on storage.
        }
        deliveryState.hasDelivered = true;
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);

        if (!session.isInterrupted()) {
          StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING);
        }
      }
    } finally {
      logger.endGroup(groupId, 'stopped');
      unregisterInterruptible(childStreamId);
      ToolUseFollowUpQueue.release(childStreamId);
      activeCodexDelivery.delete(executionId);
      const threadId = thread.id;
      if (threadId) threadRegistry.delete(threadId);
      // Persist terminal status before untracking — untrackExecution fires
      // notifyWaiters, so consumers must see the final status on disk.
      await writeTerminalStatus(executionId, 'completed').catch(() => {});
      untrackExecution(executionId);

      if (StreamStatusService.get(childStreamId) === STREAM_STATUS.WAITING) {
        StreamStatusService.set(childStreamId, STREAM_STATUS.READY);
      }
    }
  })();
}

// ============================================================================
// Thread creation
// ============================================================================

async function createCodexThread(
  input: CodexInput,
  workingDir?: string,
): Promise<Thread> {
  const CodexClass = await importCodexClass();
  const codex = new CodexClass({ codexPathOverride: findCodexBinaryPath() });
  const config = await getCodexConfig();
  const sandboxMode = input.sandbox_mode;
  // Resumed threads keep their stored workspace unless explicitly overridden.
  const workspace =
    workingDir || !input.thread_id
      ? config.buildCodexWorkspaceOptions(workingDir)
      : {};
  const threadOptions = {
    ...workspace,
    sandboxMode,
    model: config.CODEX_CLI_MODEL,
    modelReasoningEffort: config.getCodexCliReasoningEffort(),
    skipGitRepoCheck: true as const,
  };
  return input.thread_id
    ? codex.resumeThread(input.thread_id, threadOptions)
    : codex.startThread(threadOptions);
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
    'Auth is handled by the CLI itself — use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var. ' +
    'Always async: returns immediately with an execution ID; each turn is delivered back as a follow-up message (including the thread_id). ' +
    'Pass thread_id on a later call to send a follow-up instruction to an existing session — mirrors delegate_agent(execution_id=…).',
  schema: CodexInputSchema,
}) {
  protected async execute(input: CodexInput): Promise<ToolResult> {
    if (!input.sandbox_mode) {
      const config = await getCodexConfig();
      input.sandbox_mode = config.getCodexSandboxMode();
    }

    const approvalLabel = `[codex ${input.sandbox_mode}] ${input.prompt}`;
    const approval = await requestBashApproval({ command: approvalLabel });
    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(
        approvalLabel,
        approval.userMessage,
      );
    }

    const ctx = getCurrentToolFileInteractionContext();
    ctx?.onExecutionReady?.();

    if (input.thread_id && threadRegistry.has(input.thread_id)) {
      return resumeCodexThread(input.thread_id, input.prompt);
    }
    // Fall through when the thread's in-memory loop is gone (extension
    // reload, crash): createCodexThread resumes via the SDK from disk.
    return launchCodexSession(input, ctx?.streamId, ctx?.executionId);
  }
}

async function launchCodexSession(
  input: CodexInput,
  parentStreamId: StreamTabId | undefined,
  parentExecutionId: ExecutionId | undefined,
): Promise<ToolResult> {
  if (!parentStreamId) {
    throw new ToolError(
      'Codex requires a parent stream context — it must be called from an active tool-use agent.',
    );
  }

  const ctx = getCurrentToolFileInteractionContext();
  const workingDir = parseWorkingDirectory(ctx?.workingDirectory);
  const thread = await createCodexThread(input, workingDir);

  const executionId = generateExecutionId();
  await ensureRunDir(executionId);

  const codexConfig = await getCodexConfig();
  const config = codexConfig.buildCodexConfig(input.prompt);

  try {
    await registerExecution(executionId, config, 'codex', parentExecutionId);
  } catch {
    throw new ToolError('Failed to register Codex execution.');
  }

  const { childStreamId, logger } = createChildStream(
    executionId,
    parentStreamId,
    {
      streamPrefix: 'codex@codex-sdk',
      streamCategory: AgentCategory.ToolUse,
      agentName: 'codex',
      description: input.prompt,
      config,
      toolName: 'codex',
    },
  );

  startCodexLoop({
    thread,
    childStreamId,
    parentStreamId,
    executionId,
    logger,
    initialPrompt: input.prompt,
  });

  const preview = truncateWithEllipsis(input.prompt, 60);
  return {
    summary: `Launched Codex: ${preview}`,
    output: [
      `Codex agent launched (sandbox: ${input.sandbox_mode}).`,
      `Execution ID: ${executionId}`,
      `Stream tab: ${childStreamId}`,
      `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id — pass it to codex on a later call to send a follow-up instruction.`,
    ].join('\n'),
  };
}

async function resumeCodexThread(
  threadId: string,
  prompt: string,
): Promise<ToolResult> {
  const stored = threadRegistry.get(threadId);
  if (!stored) {
    throw new ToolError(
      `Codex thread '${threadId}' is not active. It may have completed or been stopped; start a new session without thread_id.`,
    );
  }

  const deliveryState = activeCodexDelivery.get(stored.executionId);
  if (!deliveryState) {
    throw new ToolError(
      `Codex execution '${stored.executionId}' is no longer tracked for delivery.`,
    );
  }
  if (!deliveryState.hasDelivered) {
    throw new ToolError(
      `Codex thread '${threadId}' is still processing. Wait for its result before sending a follow-up.`,
    );
  }
  deliveryState.hasDelivered = false;
  try {
    const queue = ToolUseFollowUpQueue.acquire(stored.childStreamId);
    queue.enqueue(prompt);
  } catch (err) {
    // Restore the flag so the thread doesn't get permanently locked if the
    // enqueue path ever starts throwing (mirrors DelegationTools).
    deliveryState.hasDelivered = true;
    throw err;
  }

  const preview = truncateWithEllipsis(prompt, 60);
  return {
    summary: `Follow-up sent to Codex: ${preview}`,
    output: [
      `Follow-up instruction queued for Codex thread '${threadId}'. The agent will process it and deliver a new result automatically.`,
      `Execution ID: ${stored.executionId}`,
    ].join('\n'),
  };
}
