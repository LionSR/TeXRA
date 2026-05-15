/**
 * Inquiry tool — human-in-the-loop bridge to external AI models.
 *
 * The agent dispatches a self-contained question; the user later pastes
 * the external model's answer back via the inquiry panel. Dispatch is
 * non-blocking: the tool returns immediately with `dispatched` and the
 * cycle continues. When an answer (or rejection) arrives — even hours
 * later, even after extension reload — the action handler injects a
 * `[inquiry] …` continuation message that auto-resumes the originating
 * stream.
 *
 * Three subcommands:
 *   - `ask`  → dispatch (default behavior)
 *   - `read` → return full transcript of one thread
 *   - `list` → enumerate threads by status / scope
 */

import { z } from 'zod';

import { tryUseRunContext } from '@agent/runtime/RunContext';
import { AgentLogger } from '@logger/AgentLogger';
import {
  ExternalInquiryThreadIdSchema,
  type ExternalInquiryThreadId,
  type InquiryActionMessage,
  type StreamTabId,
} from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { requireRuntimeHost } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';

import { collectKnownSessionLinks } from './externalInquiryResultFormatter';
import {
  ensureExternalInquiryThreadMirror,
  getThreadSummary,
  listThreadsByStatus,
  markDropped,
  readExternalInquiryThread,
  recordAnswerForOpenTurn,
  recordOpenQuestion,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';
import {
  injectContinuationForAnsweredThread,
  injectContinuationForDroppedThread,
} from './inquiryContinuation';

const logger = new AgentLogger('InquiryTool');

// ============================================================================
// Schemas
// ============================================================================

const AskSchema = z.object({
  command: z
    .literal('ask')
    .describe(
      'Dispatch a question to the user (who will consult an external AI model). ' +
        'Returns immediately with {status: "dispatched", thread_id}. ' +
        'Do NOT wait — the answer arrives as a separate [inquiry] continuation message later.',
    ),
  question: z
    .string()
    .min(1)
    .describe(
      'The self-contained question. The external model has NO context from this conversation; ' +
        'include all definitions, notation, and problem setup directly.',
    ),
  thread_id: ExternalInquiryThreadIdSchema.nullish().describe(
    'Omit to start a new thread. Pass an existing answered thread_id to ask a follow-up — ' +
      'prior Q/A in that thread is preserved and shown to the user. ' +
      'Passing a thread_id that is still open or dropped will error.',
  ),
  context: z
    .string()
    .nullish()
    .describe(
      'Short note shown to the user explaining why this question is being asked.',
    ),
  suggestSearch: z
    .boolean()
    .nullish()
    .describe(
      'Set true when the external model should enable web search for this question.',
    ),
  attachFiles: z
    .array(z.string())
    .nullish()
    .describe(
      'Workspace-relative paths the user should upload to the external model.',
    ),
});

const ReadSchema = z.object({
  command: z
    .literal('read')
    .describe(
      'Read the full untruncated transcript of one inquiry thread. ' +
        'Use this when a [inquiry] continuation truncated content you need, ' +
        'or when revisiting an earlier thread.',
    ),
  thread_id: ExternalInquiryThreadIdSchema.describe('The thread to read.'),
});

const ListSchema = z.object({
  command: z
    .literal('list')
    .describe(
      'Enumerate inquiry threads. Filter by status to find what is still pending, what has been ' +
        'answered, or what was dropped. Useful for self-orientation after multiple wake-ups, ' +
        'before starting a new turn after a long pause, or to recover a forgotten thread_id.',
    ),
  status: z
    .enum(['open', 'answered', 'dropped', 'any'])
    .prefault('open')
    .describe(
      '"open" → awaiting user answer (default — matches the most common need). ' +
        '"answered" → user has submitted an answer. ' +
        '"dropped" → user rejected the inquiry. ' +
        '"any" → all threads regardless of status.',
    ),
  scope: z
    .enum(['stream', 'all'])
    .prefault('stream')
    .describe(
      '"stream" → only threads belonging to this stream; "all" → every stream\'s threads.',
    ),
});

const InquiryInputSchema = z.discriminatedUnion('command', [
  AskSchema,
  ReadSchema,
  ListSchema,
]);

export type InquiryInput = z.infer<typeof InquiryInputSchema>;

// ============================================================================
// Action handler (called by the host when the panel submits/drops)
// ============================================================================

export async function handleExternalInquiryAction(
  payload: InquiryActionMessage,
): Promise<void> {
  if (payload.action === 'submit') {
    const persisted = await recordAnswerForOpenTurn({
      threadId: payload.threadId,
      answer: payload.answer,
      sessionLinks: payload.sessionLinks ?? undefined,
    });
    if (!persisted) {
      logger.warn(
        `Inquiry submit ignored: thread ${payload.threadId} has no open turn.`,
      );
      return;
    }
    await injectContinuationForAnsweredThread(payload.threadId);
    return;
  }

  // drop
  await markDropped({ threadId: payload.threadId });
  await injectContinuationForDroppedThread(payload.threadId);
}

// ============================================================================
// Read / list subcommand outputs
// ============================================================================

function buildReadOutput(manifest: ExternalInquiryThreadManifest): ToolResult {
  const lines = [
    `Thread: ${manifest.threadId}`,
    `Status: ${manifest.status}`,
    `Turns:  ${manifest.turns.length}`,
    `Updated: ${manifest.updatedAt}`,
  ];

  for (const turn of manifest.turns) {
    lines.push('', '─'.repeat(60));
    lines.push(`Turn ${turn.turnIndex} · ${turn.timestamp}`);
    if (turn.context) lines.push(`Context: ${turn.context}`);
    lines.push('', 'Q:', turn.question);
    if (turn.answer) {
      lines.push('', `A: (answered ${turn.answeredAt ?? '—'})`, turn.answer);
      if (turn.sessionLinks?.length) {
        lines.push('', 'Session links:');
        for (const link of turn.sessionLinks) lines.push(`  - ${link}`);
      }
    } else {
      lines.push('', '(awaiting user answer)');
    }
  }

  return {
    summary: `Inquiry thread ${manifest.threadId} (${manifest.status}, ${manifest.turns.length} turn${manifest.turns.length === 1 ? '' : 's'})`,
    output: lines.join('\n'),
  };
}

function buildListOutput(
  summaries: {
    threadId: ExternalInquiryThreadId;
    status: string;
    lastQuestionPreview: string;
    turnCount: number;
    lastActivityIso: string;
    parentStreamId: string | null;
  }[],
  filterStatus: string,
  scope: string,
): ToolResult {
  if (summaries.length === 0) {
    return {
      summary: `No inquiry threads (${filterStatus}, scope=${scope})`,
      output: '(no threads)',
    };
  }
  const lines = [
    `${summaries.length} thread(s) (${filterStatus}, scope=${scope}):`,
  ];
  for (const s of summaries) {
    lines.push(
      `  ${s.threadId}  [${s.status}]  turns=${s.turnCount}  updated=${s.lastActivityIso}`,
    );
    lines.push(`    "${s.lastQuestionPreview}"`);
  }
  return {
    summary: `Inquiry threads: ${summaries.length}`,
    output: lines.join('\n'),
  };
}

// ============================================================================
// Tool definition
// ============================================================================

const TOOL_DESCRIPTION = `Ask a question to an external AI model (ChatGPT, Gemini, Claude, etc.) via the user's own subscription, or inspect prior inquiry threads.

This tool is NON-BLOCKING. The 'ask' subcommand dispatches a question and returns immediately with {status: "dispatched", thread_id}. The user will paste the external model's answer back through the inquiry panel at some later point — possibly minutes or hours later. When the answer arrives, you will be woken with a [inquiry] continuation message on the originating stream.

Do NOT wait on a dispatched question. Either continue with independent work or end your turn now and let the continuation wake you up.

Subcommands:
  - ask   (default behavior) — dispatch a new question or follow up on an existing thread
  - read  — return the full untruncated transcript of one inquiry thread
  - list  — enumerate inquiry threads by status (open / answered / dropped / any) and scope (this stream / all)

IMPORTANT for 'ask':
  Questions MUST be self-contained. The external model has NO context from this conversation. Include all background, definitions, notation, and problem setup directly.

Follow-up semantics:
  Omit thread_id to start a new thread. Pass an answered thread_id to ask a follow-up turn; prior Q/A is preserved and rendered as a conversation in the user's panel. You cannot re-dispatch on an open or dropped thread — read or list to recover state instead.

When the [inquiry] continuation arrives, its Q is truncated to 400 chars and its A to 2000 chars. If you need the full content, call inquiry { command: 'read', thread_id }.

Tips for effective questions:
  - State the problem completely with all definitions
  - Include relevant equations and notation
  - Specify what kind of answer you need (proof sketch, calculation, reference, etc.)
  - Set suggestSearch=true when the question could benefit from web search
  - Use attachFiles to list workspace files the user should upload to the external model

Do not treat paper-specific claims from the external model as automatically verified — verify with arxiv_search / arxiv_metadata / download_arxiv_source before building on them.`;

export class ExternalInquiryTool extends defineTool({
  name: 'inquiry',
  description: TOOL_DESCRIPTION,
  schema: InquiryInputSchema,
}) {
  protected async execute(input: InquiryInput): Promise<ToolResult> {
    const context = tryUseRunContext();
    const runtimeHost = requireRuntimeHost('inquiry', context);
    const streamId = context?.streamId;
    const executionId = context?.executionId;

    switch (input.command) {
      case 'ask':
        return this.executeAsk({ input, streamId, runtimeHost, executionId });
      case 'read':
        return this.executeRead({ input, executionId });
      case 'list':
        return this.executeList({ input, streamId });
    }
  }

  private async executeAsk(args: {
    input: Extract<InquiryInput, { command: 'ask' }>;
    streamId: StreamTabId | undefined;
    runtimeHost: ReturnType<typeof requireRuntimeHost>;
    executionId?: string;
  }): Promise<ToolResult> {
    const { input, streamId, runtimeHost, executionId } = args;
    if (!streamId) {
      throw new ToolError(
        'inquiry { command: "ask" } requires an active stream context.',
      );
    }

    logger.info(
      `Inquiry dispatch [${input.thread_id ?? 'new'}]: ${input.question.slice(0, 100)}...`,
    );

    const persisted = await recordOpenQuestion({
      threadId: input.thread_id ?? undefined,
      parentStreamId: streamId,
      question: input.question,
      context: input.context ?? undefined,
      suggestSearch: input.suggestSearch ?? undefined,
      attachFiles: input.attachFiles ?? undefined,
    });

    // Mirror to execution so the agent can read prior turns via the executions tool.
    if (executionId) {
      try {
        await ensureExternalInquiryThreadMirror({
          executionId,
          threadId: persisted.threadId,
        });
      } catch (err) {
        logger.warn(
          `Failed to mirror inquiry thread ${persisted.threadId} to execution ${executionId}: ${String(err)}`,
        );
      }
    }

    runtimeHost.emit('requestEnsureProgressView', {});
    runtimeHost.emit('setActiveStream', { streamId });
    runtimeHost.emit('showExternalInquiry', {
      requestId: persisted.threadId, // legacy field — panel addresses by threadId now
      question: input.question,
      threadId: persisted.threadId,
      context: input.context ?? undefined,
      suggestSearch: input.suggestSearch ?? undefined,
      attachFiles: input.attachFiles ?? undefined,
      sessionLinks: collectKnownSessionLinks(persisted.manifest),
      allowBypass: false,
      streamId,
    });

    // Background Tasks panel: announce the open thread.
    const summary = await getThreadSummary(persisted.threadId);
    if (summary) {
      runtimeHost.emit('inquiryThreadUpdated', summary);
    }

    const message =
      'Question dispatched to the user. The tool returned without waiting. ' +
      'You will be woken with a continuation message when an answer arrives. ' +
      `Do NOT re-dispatch on thread_id=${persisted.threadId}. ` +
      'If your next step depends on this answer, end your turn now; ' +
      'otherwise proceed with independent work.';

    return {
      summary: `Inquiry dispatched (${persisted.threadId})`,
      output: `status: dispatched\nthread_id: ${persisted.threadId}\n\n${message}`,
    };
  }

  private async executeRead(args: {
    input: Extract<InquiryInput, { command: 'read' }>;
    executionId?: string;
  }): Promise<ToolResult> {
    const manifest = await readExternalInquiryThread(args.input.thread_id);
    if (!manifest) {
      throw new ToolError(
        `External inquiry thread not found: ${args.input.thread_id}`,
      );
    }
    if (args.executionId) {
      try {
        await ensureExternalInquiryThreadMirror({
          executionId: args.executionId,
          threadId: manifest.threadId,
        });
      } catch {
        // mirroring is best-effort
      }
    }
    return buildReadOutput(manifest);
  }

  private async executeList(args: {
    input: Extract<InquiryInput, { command: 'list' }>;
    streamId: StreamTabId | undefined;
  }): Promise<ToolResult> {
    const { input, streamId } = args;
    if (input.scope === 'stream' && !streamId) {
      throw new ToolError(
        'inquiry { command: "list", scope: "stream" } requires an active stream context. ' +
          'Use scope: "all" to list across streams.',
      );
    }

    const summaries = await listThreadsByStatus({
      status: input.status,
      scope: input.scope,
      streamId,
    });
    return buildListOutput(summaries, input.status, input.scope);
  }
}
