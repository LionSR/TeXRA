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

import {
  getRunContextExecutionId,
  getRunContextSession,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { createChannelTrace } from '@logger';
import {
  ExternalInquiryThreadIdSchema,
  type ExternalInquiryPermission,
  type ExternalInquiryThreadSummary,
  type InquiryActionMessage,
  type StreamTabId,
} from '@shared/schemas';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { requireRuntimeHost } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';
import { formatResultCount } from '@utils/text/stringUtils';

import { collectKnownSessionLinks } from './externalInquiryResultFormatter';
import {
  ensureExternalInquiryThreadMirror,
  getThreadSummary,
  getOpenTurnDraft,
  listThreadsByStatus,
  markDropped,
  manifestToTranscript,
  readExternalInquiryThread,
  recordAnswerForOpenTurn,
  recordOpenQuestion,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';
import {
  injectContinuationForAnsweredThread,
  injectContinuationForDroppedThread,
} from './inquiryContinuation';

const logger = createChannelTrace('InquiryTool');

// ============================================================================
// Schemas
// ============================================================================

const AskSchema = z.strictObject({
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

const ReadSchema = z.strictObject({
  command: z
    .literal('read')
    .describe(
      'Read the full untruncated transcript of one inquiry thread. ' +
        'Use this when a [inquiry] continuation truncated content you need, ' +
        'or when revisiting an earlier thread.',
    ),
  thread_id: ExternalInquiryThreadIdSchema.describe('The thread to read.'),
});

const ListSchema = z.strictObject({
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
  options: { session?: SessionHandle } = {},
): Promise<void> {
  const session = options.session ?? defaultSession();
  if (payload.action === 'submit') {
    const persisted = await recordAnswerForOpenTurn({
      threadId: payload.threadId,
      answer: payload.answer,
      sessionLinks: payload.sessionLinks ?? undefined,
    });
    // Removes the inquiry card from `ApprovalRequestHandler.pending`; without
    // this the request would replay on next webview load and the stream would
    // be reported as having pending permissions forever. Emit even for stale
    // submits so duplicate/delayed UI actions do not leave a leaked permission.
    session.interactions.resolve(payload.threadId, {
      kind: 'externalInquiry',
      action: 'submit',
    });
    if (!persisted) {
      logger.warn(
        `Inquiry submit ignored: thread ${payload.threadId} has no open turn.`,
      );
      return;
    }
    // Pass the manifest we just wrote so the injector doesn't re-read from
    // disk — a concurrent follow-up `ask` from another stream could flip
    // the status back to `open` between writes and would otherwise cause
    // the continuation to silently drop.
    await injectContinuationForAnsweredThread(
      payload.threadId,
      persisted.manifest,
      options.session,
    );
    return;
  }

  // drop — only flips status if the thread is still open; see markDropped.
  if (payload.feedback) {
    logger.info(`Inquiry ${payload.threadId} dropped with feedback`, {
      data: payload.feedback,
    });
  }
  const droppedManifest = await markDropped({ threadId: payload.threadId });
  session.interactions.resolve(payload.threadId, {
    kind: 'externalInquiry',
    action: 'drop',
    feedback: payload.feedback,
  });
  if (droppedManifest) {
    await injectContinuationForDroppedThread(
      payload.threadId,
      droppedManifest,
      options.session,
    );
  } else {
    logger.warn(
      `Inquiry drop ignored: thread ${payload.threadId} is no longer open ` +
        `(stale/duplicate drop after submit?). Skipping continuation.`,
    );
  }
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
    switch (turn.kind) {
      case 'answered':
        lines.push('', `A: (answered ${turn.answeredAt})`, turn.answer);
        if (turn.sessionLinks?.length) {
          lines.push('', 'Session links:');
          for (const link of turn.sessionLinks) lines.push(`  - ${link}`);
        }
        break;
      case 'open':
        lines.push('', '(awaiting user answer)');
        break;
      case 'answeredUnhydrated':
        lines.push(
          '',
          '(answer recorded but not yet loaded — reload the thread)',
        );
        break;
    }
  }

  return {
    status: 'executed',
    summary: `Inquiry thread ${manifest.threadId} (${manifest.status}, ${formatResultCount(manifest.turns.length, 'turn')})`,
    output: lines.join('\n'),
  };
}

function buildListOutput(
  summaries: ExternalInquiryThreadSummary[],
  filterStatus: string,
  scope: string,
): ToolResult {
  if (summaries.length === 0) {
    return {
      status: 'executed',
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
    status: 'executed',
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
  - ask   — dispatch a new question or follow up on an existing thread
  - read  — return the full untruncated transcript of one inquiry thread
  - list  — enumerate inquiry threads. Defaults: status='open', scope='stream'

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
    const streamId = getRunContextStreamId(context);
    const executionId = getRunContextExecutionId(context);

    // Only `ask` emits events. `read` and `list` are pure storage reads
    // and stay usable in contexts without a wired runtime host.
    switch (input.command) {
      case 'ask': {
        const runtimeHost = requireRuntimeHost('inquiry', context);
        return this.executeAsk({
          input,
          streamId,
          runtimeHost,
          executionId,
          session: getRunContextSession(context),
        });
      }
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
    session?: SessionHandle;
  }): Promise<ToolResult> {
    const { input, streamId, runtimeHost, executionId, session } = args;
    if (!streamId) {
      throw new ToolError(
        'inquiry { command: "ask" } requires an active stream context.',
      );
    }
    const ownerSession = session ?? defaultSession();

    logger.info(`Inquiry dispatch [${input.thread_id ?? 'new'}]`, {
      data: input.question.slice(0, 100),
    });

    const persisted = await recordOpenQuestion({
      threadId: input.thread_id ?? undefined,
      parentStreamId: streamId,
      question: input.question,
      context: input.context ?? undefined,
      suggestSearch: input.suggestSearch ?? undefined,
      attachFiles: input.attachFiles ?? undefined,
    });
    const manifest =
      (await readExternalInquiryThread(persisted.threadId)) ??
      persisted.manifest;

    // Mirror to execution so the agent can read prior turns via the executions tool.
    if (executionId) {
      try {
        await ensureExternalInquiryThreadMirror({
          executionId,
          threadId: persisted.threadId,
        });
      } catch (err) {
        logger.warn(
          `Failed to mirror inquiry thread ${persisted.threadId} to execution ${executionId}`,
          { data: err },
        );
      }
    }

    // Register the asking stream without switching the active view: hosts
    // own presentation focus (the extension/desktop progress views badge the
    // stream row, the CLI TUI activates on modal present) — #8246.
    runtimeHost.emit('requestEnsureProgressView', {});
    ownerSession.events.emit({
      scope: 'session',
      event: {
        type: 'setActiveStream',
        payload: {
          streamId,
          suppressViewSwitch: true,
          ensureVisible: true,
        },
      },
    });
    const isFollowUp = !!input.thread_id;
    const basePermission = {
      requestId: persisted.threadId, // legacy field — panel addresses by threadId now
      question: input.question,
      threadId: persisted.threadId,
      context: input.context ?? undefined,
      suggestSearch: input.suggestSearch ?? undefined,
      attachFiles: input.attachFiles ?? undefined,
      allowBypass: false,
      streamId,
    };
    const permission: ExternalInquiryPermission = isFollowUp
      ? {
          ...basePermission,
          mode: 'followUp',
          sessionLinks: collectKnownSessionLinks(manifest),
          draft: getOpenTurnDraft(manifest),
          transcript: manifestToTranscript(manifest),
        }
      : {
          ...basePermission,
          mode: 'new',
          sessionLinks: null,
          draft: null,
          transcript: null,
        };
    const interaction =
      runtimeHost.interactions?.openExternalInquiry?.(permission);
    if (!interaction) {
      throw new Error('HostInteractions.openExternalInquiry is required');
    }
    await interaction;

    // Background Tasks panel: announce the open thread.
    const summary = await getThreadSummary(persisted.threadId);
    if (summary) {
      ownerSession.events.emit({
        scope: 'session',
        event: {
          type: 'inquiryThreadUpdated',
          payload: summary,
        },
      });
    }

    const message =
      'Question dispatched to the user. The tool returned without waiting. ' +
      'You will be woken with a continuation message when an answer arrives. ' +
      `Do NOT re-dispatch on thread_id=${persisted.threadId}. ` +
      'If your next step depends on this answer, end your turn now; ' +
      'otherwise proceed with independent work.';

    return {
      status: 'executed',
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
