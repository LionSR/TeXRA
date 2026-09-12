/**
 * Inquiry tool — human-in-the-loop bridge to external AI models.
 *
 * The agent dispatches a self-contained question; the user later pastes
 * the external model's answer back via the inquiry panel. The question is a
 * request like any other (`request.opened { kind: 'externalInquiry' }`, one
 * run model, 3.7), whose `thread` names the earlier turn it follows up;
 * dispatch is non-blocking: the tool returns immediately with `dispatched`
 * and the cycle continues. When the decision arrives, even hours later,
 * even after a restart, `recordInquiryDecision` records it on the thread and
 * delivers a `[inquiry]` follow-up that wakes or resumes the run.
 *
 * Three subcommands:
 *   - `ask`  → dispatch (default behavior)
 *   - `read` → return full transcript of one thread
 *   - `list` → enumerate threads by status / scope
 */

import { Effect } from 'effect';
import { z } from 'zod';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { ToolCall } from '@agent/runtime/ToolCall';
import { createLog } from '@logger/logUtils';
import {
  type InquiryThreadRecord,
  aggregateId as qualifyAggregateId,
  InquiryThreadIdSchema,
  ToolError,
  type RunId,
  type ExternalInquiryPermission,
  type InquiryThreadSummary,
  type ToolResult,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { formatResultCount } from '@utils/text/stringUtils';

import { collectKnownSessionLinks } from './inquiryRecordFormatting';

const logger = createLog('InquiryTool');

// ============================================================================
// Schemas
// ============================================================================

// Branches use looseObject (not strictObject): provider conversion flattens
// the union into one advertised object and OpenAI-compatible providers
// null-fill the properties belonging to the other commands. See AGENTS.md
// "Tool input schemas".
const AskSchema = z.looseObject({
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

const ReadSchema = z.looseObject({
  command: z
    .literal('read')
    .describe(
      'Read the full untruncated transcript of one inquiry thread. ' +
        'Use this when a [inquiry] continuation truncated content you need, ' +
        'or when revisiting an earlier thread.',
    ),
  thread_id: InquiryThreadIdSchema.describe('The thread to read.'),
});

const ListSchema = z.looseObject({
  command: z
    .literal('list')
    .describe(
      'Enumerate inquiry threads. Filter by status to find what is still pending, what has been ' +
        'answered, or what was dropped. Useful for self-orientation after multiple wake-ups, ' +
        'before starting a new turn after a long pause, or to recover a forgotten thread_id.',
    ),
  status: nullishWithDefault(
    z.enum(['open', 'answered', 'dropped', 'any']),
    'open',
  ).describe(
    '"open" → awaiting user answer (default: matches the most common need). ' +
      '"answered" → user has submitted an answer. ' +
      '"dropped" → user rejected the inquiry. ' +
      '"any" → all threads regardless of status.',
  ),
  scope: nullishWithDefault(z.enum(['run', 'all']), 'run').describe(
    '"run" → only threads belonging to this run; "all" → every run\'s threads.',
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

function buildReadOutput(manifest: InquiryThreadRecord): ToolResult {
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
  - list : enumerate inquiry threads. Defaults: status='open', scope='run'

Dispatch is non-blocking: 'ask' returns immediately with {status: "dispatched", thread_id}; continue independent work or end your turn, and the answer, possibly minutes or hours later, arrives as a [inquiry] continuation message on the originating run.

Follow-up semantics:
  Omit thread_id to start a new thread. Pass an answered thread_id to ask a follow-up turn; prior Q/A is preserved and rendered as a conversation in the user's panel. You cannot re-dispatch on an open or dropped thread: read or list to recover state instead.

When the [inquiry] continuation arrives, its Q is truncated to 400 chars and its A to 2000 chars. If you need the full content, call inquiry { command: 'read', thread_id }.

Do not treat paper-specific claims from the external model as automatically verified: verify with arxiv_search / arxiv_metadata / download_arxiv_source before building on them.`;

export class ExternalInquiryTool extends defineTool({
  name: 'inquiry',
  // Requires the long-lived graphical inquiry panel.
  unavailableHosts: ['cli'],
  requiresApproval: true,
  description: TOOL_DESCRIPTION,
  schema: InquiryInputSchema,
}) {
  protected execute(input: InquiryInput) {
    return Effect.gen({ self: this }, function* () {
      const toolCall = yield* ToolCall;
      const runId = toolCall.run?.runId;
      switch (input.command) {
        case 'ask':
          if (!toolCall.run?.session.interactions) {
            return yield* Effect.fail(
              new ToolError(
                'inquiry requires a session with host interactions.',
              ),
            );
          }
          return yield* this.executeAsk(input, runId, toolCall.run.session);
        case 'read':
          return yield* this.executeRead(input);
        case 'list':
          return yield* this.executeList(input, runId);
      }
    });
  }

  private executeAsk(
    input: Extract<InquiryInput, { command: 'ask' }>,
    runId: RunId | undefined,
    session: SessionHandle,
  ): Effect.Effect<ToolResult, Error, InquiryRecords> {
    return Effect.gen(function* () {
      const records = yield* InquiryRecords;
      if (!runId) {
        return yield* Effect.fail(
          new ToolError(
            'inquiry { command: "ask" } requires an active run context.',
          ),
        );
      }
      const questionContext = input.context ?? undefined;
      const suggestSearch = input.suggestSearch ?? undefined;
      const attachFiles = input.attachFiles ?? undefined;

      logger.info(`Inquiry dispatch [${input.thread_id ?? 'new'}]`, {
        data: input.question.slice(0, 100),
      });

      const manifest = yield* records.recordOpenQuestion({
        threadId: input.thread_id ?? undefined,
        parentRunId: runId,
        question: input.question,
        context: questionContext,
        suggestSearch,
        attachFiles,
      });
      // Use the record committed by recordOpenQuestion.
      // A re-read would only reintroduce the write/read race the continuation
      // injectors already avoid via writer snapshots.

      // The first turn's request is the thread itself; a follow-up turn is
      // its own request whose `thread` names the first, which is the whole
      // of the inquiry's multi-turn.
      const turnIndex = manifest.turns.at(-1)?.turnIndex ?? 1;
      const requestId =
        turnIndex === 1
          ? manifest.threadId
          : `${manifest.threadId}:${turnIndex}`;
      const permission: ExternalInquiryPermission = {
        requestId,
        question: input.question,
        threadId: manifest.threadId,
        context: questionContext,
        suggestSearch,
        attachFiles,
        allowBypass: false,
        runId,
        sessionLinks: collectKnownSessionLinks(manifest),
        transcript: manifest.turns,
      };
      yield* session
        .commit([
          {
            type: 'request.opened',
            aggregateId: qualifyAggregateId('run', runId),
            requestId,
            payload: { kind: 'externalInquiry', data: permission },
            thread: turnIndex === 1 ? null : manifest.threadId,
          },
        ])
        .pipe(
          Effect.mapError(
            (error) =>
              new Error(`The inquiry request could not be opened: ${error}`),
          ),
          // The turn is committed in the global inquiry database before the
          // request that renders it, and the two stores cannot share a
          // transaction. A publication that fails or is interrupted takes
          // the turn back down with it: left open, no surface would list it
          // and no later `ask` could re-dispatch on the thread.
          Effect.onError(() =>
            records
              .markDropped({ threadId: manifest.threadId, turnIndex })
              .pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    logger.warn(
                      `Inquiry thread ${manifest.threadId} stays open after its request failed to open`,
                      { data: error },
                    );
                  }),
                ),
                Effect.asVoid,
              ),
          ),
        );

      // Background Tasks panel: announce the open thread.
      const summary = yield* records.getThreadSummary(manifest.threadId);
      if (summary) {
        session.publish([
          {
            type: 'inquiryThreadUpdated',
            aggregateId: qualifyAggregateId('inquiry', summary.threadId),
            ...summary,
          },
        ]);
      }

      const message =
        'Question dispatched to the user. The tool returned without waiting. ' +
        'You will be woken with a continuation message when an answer arrives. ' +
        `Do NOT re-dispatch on thread_id=${manifest.threadId}. ` +
        'If your next step depends on this answer, end your turn now; ' +
        'otherwise proceed with independent work.';

      return executed(
        `status: dispatched\nthread_id: ${manifest.threadId}\n\n${message}`,
        `Inquiry dispatched (${manifest.threadId})`,
      );
    });
  }

  private executeRead(
    input: Extract<InquiryInput, { command: 'read' }>,
  ): Effect.Effect<ToolResult, Error, InquiryRecords> {
    return Effect.gen(function* () {
      const records = yield* InquiryRecords;
      const manifest = yield* records.readExternalInquiryThread(
        input.thread_id,
      );
      if (!manifest) {
        return yield* Effect.fail(
          new ToolError(
            `External inquiry thread not found: ${input.thread_id}`,
          ),
        );
      }
      return buildReadOutput(manifest);
    });
  }

  private executeList(
    input: Extract<InquiryInput, { command: 'list' }>,
    runId: RunId | undefined,
  ): Effect.Effect<ToolResult, Error, InquiryRecords> {
    return Effect.gen(function* () {
      const records = yield* InquiryRecords;
      if (input.scope === 'run' && !runId) {
        return yield* Effect.fail(
          new ToolError(
            'inquiry { command: "list", scope: "run" } requires an active run context. ' +
              'Use scope: "all" to list across runs.',
          ),
        );
      }

      const summaries = yield* records.listThreadsByStatus({
        status: input.status,
        scope: input.scope,
        runId,
      });
      return buildListOutput(summaries, input.status, input.scope);
    });
  }
}
