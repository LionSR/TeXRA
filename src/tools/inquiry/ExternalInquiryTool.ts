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
import { createLog } from '@logger/logUtils';
import {
  InquiryThreadIdSchema,
  ToolError,
  type ExternalInquiryPermission,
  type InquiryThreadSummary,
  type StreamTabId,
  type ToolResult,
} from '@shared/schemas';
import { requireInteractions } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { formatResultCount } from '@utils/text/stringUtils';

import { collectKnownSessionLinks } from './externalInquiryResultFormatter';
import {
  ensureExternalInquiryThreadMirror,
  getThreadSummary,
  getOpenTurnDraft,
  listThreadsByStatus,
  manifestToTranscript,
  readExternalInquiryThread,
  recordOpenQuestion,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';

const logger = createLog('InquiryTool');

// ============================================================================
// Schemas
// ============================================================================

const AskSchema = z.strictObject({
  command: z
    .literal('ask')
    .describe(
      'Dispatch a question to the user (who will consult an external AI model). ' +
        'Returns immediately with {status: "dispatched", thread_id}. ' +
        'Do NOT wait: the answer arrives as a separate [inquiry] continuation message later.',
    ),
  question: z
    .string()
    .min(1)
    .describe(
      'The self-contained question. The external model has NO context from this conversation; ' +
        'include all definitions, notation, and problem setup directly, and say what kind of ' +
        'answer you need (proof sketch, calculation, reference, etc.).',
    ),
  thread_id: InquiryThreadIdSchema.nullish().describe(
    'Omit to start a new thread. Pass an existing answered thread_id to ask a follow-up: ' +
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
  thread_id: InquiryThreadIdSchema.describe('The thread to read.'),
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
      '"open" → awaiting user answer (default: matches the most common need). ' +
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
// Read / list subcommand outputs
// ============================================================================

/**
 * Mirror a thread to the execution so the agent can read prior turns via the
 * executions tool. Best-effort: a mirroring failure must not fail the tool
 * call, but it is logged rather than swallowed.
 */
async function mirrorThreadBestEffort(
  executionId: string,
  threadId: string,
): Promise<void> {
  try {
    await ensureExternalInquiryThreadMirror({ executionId, threadId });
  } catch (err) {
    logger.warn(
      `Failed to mirror inquiry thread ${threadId} to execution ${executionId}`,
      { data: err },
    );
  }
}

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
    }
  }

  return executed(
    lines.join('\n'),
    `Inquiry thread ${manifest.threadId} (${manifest.status}, ${formatResultCount(manifest.turns.length, 'turn')})`,
  );
}

function buildListOutput(
  summaries: InquiryThreadSummary[],
  filterStatus: string,
  scope: string,
): ToolResult {
  if (summaries.length === 0) {
    return executed(
      '(no threads)',
      `No inquiry threads (${filterStatus}, scope=${scope})`,
    );
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
  return executed(lines.join('\n'), `Inquiry threads: ${summaries.length}`);
}

// ============================================================================
// Tool definition
// ============================================================================

const TOOL_DESCRIPTION = `Ask a question to an external AI model (ChatGPT, Gemini, Claude, etc.) via the user's own subscription, or inspect prior inquiry threads.

Subcommands:
  - ask  : dispatch a new question or follow up on an existing thread
  - read : return the full untruncated transcript of one inquiry thread
  - list : enumerate inquiry threads. Defaults: status='open', scope='stream'

Dispatch is non-blocking: 'ask' returns immediately with {status: "dispatched", thread_id}; continue independent work or end your turn, and the answer, possibly minutes or hours later, arrives as a [inquiry] continuation message on the originating stream.

Follow-up semantics:
  Omit thread_id to start a new thread. Pass an answered thread_id to ask a follow-up turn; prior Q/A is preserved and rendered as a conversation in the user's panel. You cannot re-dispatch on an open or dropped thread: read or list to recover state instead.

When the [inquiry] continuation arrives, its Q is truncated to 400 chars and its A to 2000 chars. If you need the full content, call inquiry { command: 'read', thread_id }.

Do not treat paper-specific claims from the external model as automatically verified: verify with arxiv_search / arxiv_metadata / download_arxiv_source before building on them.`;

export class ExternalInquiryTool extends defineTool({
  name: 'inquiry',
  hosts: {
    cli: {
      available: false,
      reason: 'Requires the long-lived graphical inquiry panel.',
    },
  },
  requiresApproval: true,
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
        const interactions = requireInteractions('inquiry', context);
        return this.executeAsk({
          input,
          streamId,
          interactions,
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
    interactions: ReturnType<typeof requireInteractions>;
    executionId?: string;
    session?: SessionHandle;
  }): Promise<ToolResult> {
    const { input, streamId, interactions, executionId, session } = args;
    if (!streamId) {
      throw new ToolError(
        'inquiry { command: "ask" } requires an active stream context.',
      );
    }
    const ownerSession = session ?? defaultSession();
    const parentGenerationId =
      ownerSession.followUps.currentGenerationId(streamId);
    if (!parentGenerationId) {
      throw new ToolError(
        'Inquiry dispatch requires an active parent continuation generation.',
      );
    }

    const questionContext = input.context ?? undefined;
    const suggestSearch = input.suggestSearch ?? undefined;
    const attachFiles = input.attachFiles ?? undefined;

    logger.info(`Inquiry dispatch [${input.thread_id ?? 'new'}]`, {
      data: input.question.slice(0, 100),
    });

    const persisted = await recordOpenQuestion({
      threadId: input.thread_id ?? undefined,
      parentStreamId: streamId,
      parentGenerationId,
      question: input.question,
      context: questionContext,
      suggestSearch,
      attachFiles,
    });
    // Use the manifest recordOpenQuestion just wrote under the thread lock —
    // a re-read would only reintroduce the write/read race the continuation
    // injectors already avoid via writer snapshots.
    const manifest = persisted.manifest;

    if (executionId) {
      await mirrorThreadBestEffort(executionId, persisted.threadId);
    }

    // Register the asking stream without switching the active view: hosts
    // own presentation focus (the extension/desktop progress views badge the
    // stream row, the CLI TUI activates on modal present) — #8246.
    interactions.emit('requestEnsureProgressView', {});
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
      context: questionContext,
      suggestSearch,
      attachFiles,
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
      ownerSession.interactions.openExternalInquiry(permission);
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

    return executed(
      `status: dispatched\nthread_id: ${persisted.threadId}\n\n${message}`,
      `Inquiry dispatched (${persisted.threadId})`,
    );
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
      await mirrorThreadBestEffort(args.executionId, manifest.threadId);
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
