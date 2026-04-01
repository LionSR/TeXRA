/**
 * External Inquiry tool — human-in-the-loop bridge to external AI models.
 *
 * The agent formulates a self-contained question. The user copies it to
 * an external model (ChatGPT, Gemini, Claude, etc.), gets an answer,
 * and pastes it back. The answer is persisted into a durable
 * external-inquiry thread and mirrored into the current execution so
 * the agent can inspect it through `executions`.
 */

import { z } from 'zod';

import { getExecutionStore } from '@agent/storage';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { ExternalInquiryAction, StreamTabId } from '@shared/schemas';
import {
  EXTERNAL_INQUIRY_ACTIONS,
  ExternalInquiryModeSchema,
  ExternalInquiryThreadIdSchema,
} from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

import {
  persistExternalInquiryTurn,
  type PersistedExternalInquiryTurn,
} from './externalInquiryStorage';

const logger = new AgentLogger('ExternalInquiryTool');
const EXTERNAL_INQUIRY_REPORT_THRESHOLD = 20_000;
const EXTERNAL_INQUIRY_PREVIEW_LENGTH = 2_000;

// ============================================================================
// Tool Schema
// ============================================================================

const ExternalInquiryInputSchema = z
  .strictObject({
    question: z
      .string()
      .describe(
        'The complete, self-contained question to ask the external model. ' +
          'MUST include all necessary background, definitions, notation, and problem setup ' +
          'because the external model has NO context from this conversation.',
      ),
    mode: ExternalInquiryModeSchema.describe(
      "'new' to start a fresh external-inquiry thread, 'followup' to continue a prior external-inquiry thread.",
    ),
    thread_id: ExternalInquiryThreadIdSchema.nullish().describe(
      'Durable external inquiry thread ID from a previous external_inquiry result. ' +
        "Required for mode='followup'. Must be omitted for mode='new'.",
    ),
    context: z
      .string()
      .nullish()
      .describe(
        'Brief note shown to the user explaining why this question is being asked.',
      ),
    suggestSearch: z
      .boolean()
      .nullish()
      .describe(
        'Set to true to suggest the user enable web search mode in the external tool.',
      ),
    attachFiles: z
      .array(z.string())
      .nullish()
      .describe(
        'Workspace-relative file paths the user should upload to the external model.',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'new' && value.thread_id != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thread_id'],
        message: "thread_id must be omitted when mode='new'.",
      });
    }

    if (value.mode === 'followup' && value.thread_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thread_id'],
        message: "thread_id is required when mode='followup'.",
      });
    }
  });

export type ExternalInquiryInput = z.infer<typeof ExternalInquiryInputSchema>;

// ============================================================================
// Pending Inquiry State
// ============================================================================

export interface ExternalInquiryResult {
  submitted: boolean;
  answer?: string;
  feedback?: string;
}

let inquiryCounter = 0;
const pendingInquiries = new Map<
  string,
  {
    streamId?: StreamTabId;
    settle: (result: ExternalInquiryResult) => void;
    isSettled: () => boolean;
  }
>();

function toCurrentExecutionPath(path: string, executionId?: string): string {
  if (!executionId) return path;
  const prefix = `/executions/${executionId}/`;
  return path.startsWith(prefix)
    ? `/executions/current/${path.slice(prefix.length)}`
    : path;
}

function currentManifestPath(
  persisted: PersistedExternalInquiryTurn,
): string | undefined {
  const mirror = persisted.executionMirrorPaths;
  if (!mirror) return undefined;
  return toCurrentExecutionPath(mirror.manifestPath, mirror.executionId);
}

function appendManifestHint(lines: string[], manifestPath?: string): void {
  if (!manifestPath) return;
  lines.push(
    '',
    `Thread manifest: ${manifestPath}`,
    `Use the executions tool with path=${manifestPath} to inspect mirrored files.`,
  );
}

function buildExternalInquiryOutput(
  persisted: PersistedExternalInquiryTurn,
  answer: string,
): string {
  const lines = [
    `Thread ID: ${persisted.threadId}`,
    `Turn: ${persisted.turn.turnIndex}`,
    'Answer from external model:',
    '',
    answer,
    '',
    `Use thread_id=${persisted.threadId} with mode='followup' to continue this external conversation.`,
  ];

  appendManifestHint(lines, currentManifestPath(persisted));

  return lines.join('\n');
}

function buildExternalInquiryReport(
  persisted: PersistedExternalInquiryTurn,
  answer: string,
): string {
  const lines = [
    'External inquiry result',
    `Thread ID: ${persisted.threadId}`,
    `Turn: ${persisted.turn.turnIndex}`,
    `Mode: ${persisted.turn.mode}`,
    `Timestamp: ${persisted.turn.timestamp}`,
    ...(persisted.turn.context ? [`Context: ${persisted.turn.context}`] : []),
    '',
    'Question:',
    persisted.turn.question,
    '',
    'Answer:',
    answer,
  ];

  const mirror = persisted.executionMirrorPaths;
  if (mirror) {
    lines.push(
      '',
      'Mirrored execution files:',
      `- Manifest: ${mirror.manifestPath}`,
      `- Question: ${mirror.questionPath}`,
      ...(mirror.contextPath ? [`- Context: ${mirror.contextPath}`] : []),
      `- Answer: ${mirror.answerPath}`,
    );
  }

  return lines.join('\n');
}

async function appendExternalInquiryReport(params: {
  executionId: string;
  persisted: PersistedExternalInquiryTurn;
  answer: string;
}): Promise<void> {
  const store = getExecutionStore(params.executionId);
  const existing = await store.readReport();
  const nextSection = buildExternalInquiryReport(
    params.persisted,
    params.answer,
  );
  const separator = '\n\n' + '='.repeat(80) + '\n\n';
  await store.writeReport(
    existing?.trim() ? `${existing}${separator}${nextSection}` : nextSection,
  );
}

function buildLongAnswerResult(
  persisted: PersistedExternalInquiryTurn,
  answer: string,
): ToolResult {
  const preview = answer.slice(0, EXTERNAL_INQUIRY_PREVIEW_LENGTH);
  const lines = [
    'The external model returned a long answer.',
    `Thread ID: ${persisted.threadId}`,
    'The full answer has been saved to /executions/current/report.',
    'Use the executions tool with path=/executions/current/report to inspect it.',
    `Use thread_id=${persisted.threadId} with mode='followup' to continue this external conversation.`,
  ];

  appendManifestHint(lines, currentManifestPath(persisted));

  if (preview) {
    lines.push('', `Preview:\n\n${preview}`);
  }

  return {
    summary: 'Received long answer from external model',
    output: lines.join('\n'),
  };
}

// ============================================================================
// Public API (called from progress view message handler)
// ============================================================================

export async function handleExternalInquiryAction(payload: {
  requestId: string;
  action: ExternalInquiryAction | 'skip';
  answer?: string;
  feedback?: string;
}): Promise<void> {
  const entry = pendingInquiries.get(payload.requestId);
  if (!entry || entry.isSettled()) return;

  const isSubmit = payload.action === EXTERNAL_INQUIRY_ACTIONS[0];

  entry.settle({
    submitted: isSubmit,
    answer: isSubmit ? payload.answer : undefined,
    feedback: isSubmit ? undefined : payload.feedback,
  });
}

/** @internal Called by unified cleanup. */
export function _rejectPendingInquiriesForStream(streamId: StreamTabId): void {
  for (const entry of pendingInquiries.values()) {
    const matches = entry.streamId === streamId;
    if (matches && !entry.isSettled()) {
      entry.settle({ submitted: false });
    }
  }
}

/** @internal Called by unified cleanup. */
export function _rejectAllPendingInquiries(): void {
  for (const entry of pendingInquiries.values()) {
    if (!entry.isSettled()) {
      entry.settle({ submitted: false });
    }
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export class ExternalInquiryTool extends defineTool({
  name: 'external_inquiry',
  description: `Ask a question to an external AI model (ChatGPT, Gemini, Claude, etc.) via the user's own subscription.

The user will copy the question to the external model's interface and paste the answer back. This enables consulting powerful models that are not directly accessible via API.

IMPORTANT: Questions MUST be self-contained. The external model has NO context from this conversation. Include all necessary background, definitions, mathematical notation, and problem setup directly in the question. Write the question as if the reader has never seen any of the preceding discussion.

Tips for effective questions:
- State the problem completely with all definitions
- Include relevant equations and notation
- Specify what kind of answer you need (proof sketch, calculation, reference, etc.)
- If this is a follow-up, summarize what was established before

Every successful call returns a durable thread_id. Pass that thread_id back with mode='followup' to continue the same external-inquiry thread in later calls, even from a future run.

Set suggestSearch=true when the question could benefit from the external model using web search (e.g., looking up recent papers, checking specific results).

Use attachFiles to list workspace files the user should upload to the external model for reference.

If the external model returns files, the user should save them into the workspace and tell you the paths.

Do not treat paper-specific claims from the external model as automatically verified. If the answer relies on a nonstandard result from a cited paper, verify it by inspecting the paper directly with tools such as arxiv_search, arxiv_metadata, and download_arxiv_source before building further conclusions on top of it.`,
  schema: ExternalInquiryInputSchema,
}) {
  protected async execute(input: ExternalInquiryInput): Promise<ToolResult> {
    const context = getCurrentToolFileInteractionContext();
    const streamId = context?.streamId;
    const executionId = context?.executionId;

    const requestId = `inquiry-${Date.now().toString(36)}-${++inquiryCounter}`;

    logger.info(
      `External inquiry [${input.mode}${input.thread_id ? ` ${input.thread_id}` : ''}]: ${input.question.substring(0, 100)}...`,
    );

    try {
      const result = await new Promise<ExternalInquiryResult>((resolve) => {
        let settled = false;
        const settle = (settledResult: ExternalInquiryResult) => {
          if (settled) return;
          settled = true;
          resolve(settledResult);
        };

        pendingInquiries.set(requestId, {
          streamId,
          settle,
          isSettled: () => settled,
        });

        bus.emit('requestEnsureProgressView', {});

        if (streamId) {
          bus.emit('setActiveStream', { streamId });
        }

        bus.emit('showExternalInquiry', {
          requestId,
          question: input.question,
          mode: input.mode,
          context: input.context ?? undefined,
          suggestSearch: input.suggestSearch ?? undefined,
          attachFiles: input.attachFiles ?? undefined,
          allowBypass: false,
          streamId: streamId ?? '',
        });
      });

      if (!result.submitted) {
        const feedback = result.feedback?.trim();
        return {
          summary: feedback
            ? 'User rejected external inquiry with feedback'
            : 'User rejected external inquiry',
          output: feedback
            ? `The user rejected this external inquiry and provided feedback:\n\n${feedback}\n\nRevise the question or try a different approach.`
            : 'The user rejected this external inquiry. Revise the question or try a different approach.',
        };
      }

      const answer = result.answer?.trim();
      if (!answer) {
        throw new ToolError('External inquiry answer cannot be empty.');
      }

      const persisted = await persistExternalInquiryTurn({
        mode: input.mode,
        threadId: input.thread_id ?? undefined,
        question: input.question,
        context: input.context ?? undefined,
        answer,
        executionId,
      });

      if (executionId) {
        await appendExternalInquiryReport({
          executionId,
          persisted,
          answer,
        });
      }

      if (executionId && answer.length > EXTERNAL_INQUIRY_REPORT_THRESHOLD) {
        return buildLongAnswerResult(persisted, answer);
      }

      return {
        summary: `Received answer from external model (${input.mode})`,
        output: buildExternalInquiryOutput(persisted, answer),
      };
    } finally {
      pendingInquiries.delete(requestId);
      bus.emit('resolveExternalInquiry', { requestId });
    }
  }
}
