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

import {
  getAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { getCurrentToolRunContext } from '@agent/toolUse/ToolFileInteractionContext';
import { AgentLogger } from '@logger/AgentLogger';
import type { ExternalInquiryAction, StreamTabId } from '@shared/schemas';
import {
  EXTERNAL_INQUIRY_ACTIONS,
  ExternalInquiryThreadIdSchema,
} from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

import {
  ensureExternalInquiryThreadMirror,
  persistExternalInquiryTurn,
  readExternalInquiryThread,
  type ExternalInquiryThreadManifest,
} from './externalInquiryStorage';
import {
  appendExternalInquiryReport,
  buildExternalInquiryResult,
  buildRejectedExternalInquiryResult,
  collectKnownSessionLinks,
} from './externalInquiryResultFormatter';

const logger = new AgentLogger('ExternalInquiryTool');

// ============================================================================
// Tool Schema
// ============================================================================

const ExternalInquiryInputSchema = z.strictObject({
  question: z
    .string()
    .describe(
      'The complete, self-contained question to ask the external model. ' +
        'MUST include all necessary background, definitions, notation, and problem setup ' +
        'because the external model has NO context from this conversation.',
    ),
  thread_id: ExternalInquiryThreadIdSchema.nullish().describe(
    'Durable external inquiry thread ID from a previous external_inquiry result. ' +
      'Omit to start a new external-inquiry thread. Pass it to continue an existing thread; ' +
      'known external session links from that thread will be shown to the user.',
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
});

export type ExternalInquiryInput = z.infer<typeof ExternalInquiryInputSchema>;

// ============================================================================
// Pending Inquiry State
// ============================================================================

export interface ExternalInquiryResult {
  submitted: boolean;
  answer?: string;
  feedback?: string;
  sessionLinks?: string[];
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

async function resolveExistingThread(
  input: ExternalInquiryInput,
  executionId?: string,
): Promise<ExternalInquiryThreadManifest | null> {
  if (!input.thread_id) return null;

  const existingThread = await readExternalInquiryThread(input.thread_id);
  if (!existingThread) {
    throw new ToolError(
      `External inquiry thread not found: ${input.thread_id}`,
    );
  }

  const sessionLinks = collectKnownSessionLinks(existingThread);
  if (sessionLinks?.length) {
    logger.debug(
      `Found ${sessionLinks.length} known external session link(s) for ${input.thread_id}`,
    );
  }

  if (executionId) {
    await ensureExternalInquiryThreadMirror({
      executionId,
      threadId: existingThread.threadId,
    });
    logger.debug(
      `Mirrored external inquiry thread ${input.thread_id} into execution ${executionId}`,
    );
  }

  return existingThread;
}

async function awaitExternalInquiryResponse(params: {
  requestId: string;
  input: ExternalInquiryInput;
  streamId?: StreamTabId;
  existingThread: ExternalInquiryThreadManifest | null;
  runtimeHost: AgentRuntimeHost;
}): Promise<ExternalInquiryResult> {
  return new Promise<ExternalInquiryResult>((resolve) => {
    let settled = false;
    const settle = (result: ExternalInquiryResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    pendingInquiries.set(params.requestId, {
      streamId: params.streamId,
      settle,
      isSettled: () => settled,
    });

    params.runtimeHost.emit('requestEnsureProgressView', {});

    if (params.streamId) {
      params.runtimeHost.emit('setActiveStream', { streamId: params.streamId });
    }

    params.runtimeHost.emit('showExternalInquiry', {
      requestId: params.requestId,
      question: params.input.question,
      threadId: params.input.thread_id ?? undefined,
      context: params.input.context ?? undefined,
      suggestSearch: params.input.suggestSearch ?? undefined,
      attachFiles: params.input.attachFiles ?? undefined,
      sessionLinks: collectKnownSessionLinks(params.existingThread),
      allowBypass: false,
      streamId: params.streamId ?? '',
    });
  });
}

// ============================================================================
// Public API (called from progress view message handler)
// ============================================================================

export async function handleExternalInquiryAction(payload: {
  requestId: string;
  action: ExternalInquiryAction | 'skip';
  answer?: string;
  feedback?: string;
  sessionLinks?: string[];
}): Promise<void> {
  const entry = pendingInquiries.get(payload.requestId);
  if (!entry || entry.isSettled()) return;

  const isSubmit = payload.action === EXTERNAL_INQUIRY_ACTIONS[0];

  entry.settle({
    submitted: isSubmit,
    answer: isSubmit ? payload.answer : undefined,
    feedback: isSubmit ? undefined : payload.feedback,
    sessionLinks: isSubmit ? payload.sessionLinks : undefined,
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
- If continuing an existing external thread, summarize what was established before

Every successful call returns a durable thread_id. Omit thread_id to start a new external-inquiry thread. Pass thread_id to continue the same thread in later calls, even from a future run.

If a result lists external session links, keep using the returned thread_id for follow-up questions. The inquiry panel will show those links to the user so they can continue the same outside conversation.

Set suggestSearch=true when the question could benefit from the external model using web search (e.g., looking up recent papers, checking specific results).

Use attachFiles to list workspace files the user should upload to the external model for reference.

If the external model returns files, the user should save them into the workspace and tell you the paths.

Do not treat paper-specific claims from the external model as automatically verified. If the answer relies on a nonstandard result from a cited paper, verify it by inspecting the paper directly with tools such as arxiv_search, arxiv_metadata, and download_arxiv_source before building further conclusions on top of it.

When you have multiple independent questions for external models, you can call external_inquiry multiple times in the same response. All inquiries will be dispatched simultaneously, allowing the user to query multiple models in parallel. Only batch truly independent questions — if one answer depends on another, ask them sequentially.`,
  schema: ExternalInquiryInputSchema,
}) {
  protected async execute(input: ExternalInquiryInput): Promise<ToolResult> {
    const context = getCurrentToolRunContext();
    const streamId = context?.streamId;
    const executionId = context?.executionId;
    const runtimeHost = context?.runtimeHost ?? getAgentRuntimeHost();

    const requestId = `inquiry-${Date.now().toString(36)}-${++inquiryCounter}`;
    const threadLabel = input.thread_id ?? 'new';

    logger.info(
      `External inquiry [${threadLabel}]: ${input.question.substring(0, 100)}...`,
    );

    const existingThread = await resolveExistingThread(input, executionId);

    try {
      const result = await awaitExternalInquiryResponse({
        requestId,
        input,
        streamId,
        existingThread,
        runtimeHost,
      });

      if (!result.submitted) {
        return buildRejectedExternalInquiryResult(result.feedback);
      }

      const answer = result.answer?.trim();
      if (!answer) {
        throw new ToolError('External inquiry answer cannot be empty.');
      }

      const persisted = await persistExternalInquiryTurn({
        threadId: input.thread_id ?? undefined,
        question: input.question,
        context: input.context ?? undefined,
        answer,
        sessionLinks: result.sessionLinks,
        executionId,
      });

      if (executionId) {
        await appendExternalInquiryReport({
          executionId,
          persisted,
          answer,
        });
      }

      return buildExternalInquiryResult({
        persisted,
        answer,
        includeLongAnswerRedirect: executionId != null,
      });
    } finally {
      pendingInquiries.delete(requestId);
      runtimeHost.emit('resolveExternalInquiry', { requestId });
    }
  }
}
