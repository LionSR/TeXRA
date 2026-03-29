/**
 * External Inquiry tool — human-in-the-loop bridge to external AI models.
 *
 * The agent formulates a self-contained question. The user copies it to
 * an external model (ChatGPT, Gemini, Claude, etc.), gets an answer,
 * and pastes it back. The answer (plus any attached files) is returned
 * to the agent as the tool result.
 *
 * Follows the same async promise pattern as bashApproval.ts.
 */

import { z } from 'zod';

import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { ExternalInquiryAction, StreamTabId } from '@shared/schemas';
import { type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

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
  mode: z
    .enum(['new', 'followup'])
    .describe(
      "'new' to start a fresh topic in the external model, " +
        "'followup' to continue a prior external conversation thread.",
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
  attachedFiles?: string[];
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

// ============================================================================
// Public API (called from progress view message handler)
// ============================================================================

export async function handleExternalInquiryAction(payload: {
  requestId: string;
  action: ExternalInquiryAction;
  answer?: string;
  attachedFiles?: string[];
}): Promise<void> {
  const entry = pendingInquiries.get(payload.requestId);
  if (!entry || entry.isSettled()) return;

  entry.settle({
    submitted: payload.action === 'submit',
    answer: payload.action === 'submit' ? payload.answer : undefined,
    attachedFiles: payload.action === 'submit' ? payload.attachedFiles : undefined,
  });
}

/** @internal Called by unified cleanup. */
export function _rejectPendingInquiriesForStream(
  streamId: StreamTabId,
): void {
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

Use mode='followup' when continuing a thread in the same external session (the user keeps that session open). Use mode='new' when starting a fresh topic.

Set suggestSearch=true when the question could benefit from the external model using web search (e.g., looking up recent papers, checking specific results).

Use attachFiles to list workspace files the user should upload to the external model for reference.`,
  schema: ExternalInquiryInputSchema,
}) {
  protected async execute(input: ExternalInquiryInput): Promise<ToolResult> {
    const context = getCurrentToolFileInteractionContext();
    const streamId = context?.streamId;

    const requestId = `inquiry-${Date.now().toString(36)}-${++inquiryCounter}`;

    logger.info(
      `External inquiry [${input.mode}]: ${input.question.substring(0, 100)}...`,
    );

    try {
      const result = await new Promise<ExternalInquiryResult>((resolve) => {
        let settled = false;
        const settle = (r: ExternalInquiryResult) => {
          if (settled) return;
          settled = true;
          resolve(r);
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
        return {
          summary: 'User skipped external inquiry',
          output:
            'The user chose to skip this external inquiry. ' +
            'Proceed without the external answer, or try a different approach.',
        };
      }

      let output = `Answer from external model:\n\n${result.answer ?? ''}`;

      if (result.attachedFiles?.length) {
        const fileList = result.attachedFiles.map((f) => `- ${f}`).join('\n');
        output += `\n\nFiles attached by user from the external model:\n${fileList}`;
      }

      return {
        summary: `Received answer from external model (${input.mode})`,
        output,
      };
    } finally {
      pendingInquiries.delete(requestId);
      bus.emit('resolveExternalInquiry', { requestId });
    }
  }
}
