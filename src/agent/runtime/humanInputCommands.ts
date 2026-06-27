import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { UserQuestionAnswers } from '@shared/schemas';
import type {
  ExternalInquiryThreadId,
  InquiryActionMessage,
  InquiryDraft,
} from '@shared/schemas/inquiry';
import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';
import { persistOpenTurnDraft } from '@tools/inquiry/externalInquiryStorage';

export interface RuntimeUserQuestionResolution {
  readonly requestId: string;
  readonly action: 'submit' | 'reject' | 'skip';
  readonly answers?: UserQuestionAnswers;
  readonly feedback?: string;
}

export type RuntimeExternalInquiryResolution = InquiryActionMessage & {
  readonly session?: SessionHandle;
};

export interface RuntimeExternalInquiryDraftPersistence {
  readonly threadId: ExternalInquiryThreadId;
  readonly draft: InquiryDraft | null;
}

/** Resolve a pending user-question request from a host/user decision. */
export function resolveRuntimeUserQuestion(
  resolution: RuntimeUserQuestionResolution,
): Promise<void> {
  return handleUserQuestionAction(resolution);
}

/** Resolve or drop a durable external inquiry thread from a host/user decision. */
export function resolveRuntimeExternalInquiry({
  session,
  ...message
}: RuntimeExternalInquiryResolution): Promise<void> {
  return handleExternalInquiryAction(message, { session });
}

/** Persist the current draft for an open external inquiry turn. */
export function persistRuntimeExternalInquiryDraft(
  request: RuntimeExternalInquiryDraftPersistence,
): Promise<void> {
  return persistOpenTurnDraft(request);
}
