import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  ExternalInquiryPermission,
  ExternalInquiryThreadSummary,
  UserQuestionAnswers,
} from '@shared/schemas';
import type {
  ExternalInquiryThreadId,
  InquiryActionMessage,
  InquiryDraft,
} from '@shared/schemas/inquiry';
import { handleUserQuestionAction } from '@tools/userQuestion';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';
import {
  getOpenTurnDraft,
  listOpenThreads,
  listThreadsByStatus,
  manifestToTranscript,
  persistOpenTurnDraft,
  readExternalInquiryThread,
  type ExternalInquiryThreadManifest,
} from '@tools/inquiry/externalInquiryStorage';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

const RUNTIME_EXTERNAL_INQUIRY_OVERVIEW_LIMIT = 100;

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

/**
 * List the bounded, host-safe external inquiry thread summaries used by
 * progress surfaces.
 */
export function listRuntimeExternalInquiryOverviewThreads(): Promise<
  ExternalInquiryThreadSummary[]
> {
  return listThreadsByStatus({
    status: 'any',
    scope: 'all',
    limit: RUNTIME_EXTERNAL_INQUIRY_OVERVIEW_LIMIT,
  });
}

/**
 * Project a durable inquiry manifest into the live permission shape consumed by
 * host progress UIs. Only an unanswered open turn attached to a parent stream is
 * resumable as a host prompt.
 */
export function runtimeExternalInquiryPermissionFromManifest(
  manifest: ExternalInquiryThreadManifest,
): ExternalInquiryPermission | null {
  if (manifest.status !== 'open') return null;
  if (!manifest.parentStreamId) return null;

  const lastTurn = manifest.turns.at(-1);
  if (!lastTurn || lastTurn.answer) return null;

  return {
    requestId: manifest.threadId,
    threadId: manifest.threadId,
    question: lastTurn.question,
    context: lastTurn.context ?? undefined,
    suggestSearch: lastTurn.suggestSearch ?? undefined,
    attachFiles: lastTurn.attachFiles ?? undefined,
    sessionLinks: collectKnownSessionLinks(manifest),
    draft: getOpenTurnDraft(manifest),
    transcript: manifestToTranscript(manifest),
    allowBypass: false,
    streamId: manifest.parentStreamId,
  };
}

/** Rehydrate unresolved durable inquiries into live host prompt permissions. */
export async function listRuntimeOpenExternalInquiryPermissions(): Promise<
  ExternalInquiryPermission[]
> {
  const open = await listOpenThreads();
  const permissions: ExternalInquiryPermission[] = [];

  for (const summary of open) {
    const manifest = await readExternalInquiryThread(summary.threadId, {
      hydrate: true,
    }).catch(() => null);
    if (!manifest) continue;

    const permission = runtimeExternalInquiryPermissionFromManifest(manifest);
    if (permission) permissions.push(permission);
  }

  return permissions;
}
