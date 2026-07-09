import type { AgentTrace } from '@agent/trace';
import type { InquiryThreadUpdatedEvent } from '@shared/schemas';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';
import {
  getOpenTurnDraft,
  listOpenThreads,
  listThreadsByStatus,
  manifestToTranscript,
  readExternalInquiryThread,
} from '@tools/inquiry/externalInquiryStorage';

import type { ApprovalRequestHandlerSet } from './progressBackendUiConfig';
import type { WebviewUpdater } from './WebviewUpdater';

const MAX_INQUIRY_THREAD_HYDRATION = 100;

type InquiryHydrationWebview = Pick<
  WebviewUpdater,
  'isAvailable' | 'syncInquiryThreads'
>;

type ExternalInquiryHandler = Pick<
  ApprovalRequestHandlerSet['externalInquiry'],
  'pendingSize' | 'show'
>;

export interface ProgressInquiryHydrationParams {
  webviewUpdater: InquiryHydrationWebview;
  externalInquiry: ExternalInquiryHandler;
  logger?: Pick<AgentTrace, 'debug'>;
}

/**
 * Synchronize the durable inquiry-thread list into the progress view. A damaged
 * manifest should not prevent stream or prompt replay, so storage errors are
 * intentionally swallowed here.
 */
export async function syncProgressInquiryThreads(
  params: Pick<ProgressInquiryHydrationParams, 'webviewUpdater'>,
): Promise<void> {
  if (!params.webviewUpdater.isAvailable()) return;

  try {
    const threads: InquiryThreadUpdatedEvent[] = await listThreadsByStatus({
      status: 'any',
      scope: 'all',
      limit: MAX_INQUIRY_THREAD_HYDRATION,
    });
    params.webviewUpdater.syncInquiryThreads(threads);
  } catch {
    // Inquiry thread history is auxiliary state; stream replay must continue.
  }
}

/**
 * Re-show manifest-backed open inquiry panels after a host restart. The
 * in-memory handler owns delivery idempotency for the current webview target;
 * this function only reconstructs missing pending entries from durable storage.
 */
export async function hydrateOpenInquiryPermissions(
  params: ProgressInquiryHydrationParams,
): Promise<void> {
  if (!params.webviewUpdater.isAvailable()) return;
  if (params.externalInquiry.pendingSize > 0) return;

  const open = await listOpenThreads().catch((error) => {
    params.logger?.debug(`Failed to list open inquiry threads: ${error}`);
    return undefined;
  });
  if (!open) return;

  for (const summary of open) {
    try {
      const manifest = await readExternalInquiryThread(summary.threadId);
      if (!manifest || manifest.status !== 'open') continue;
      if (!manifest.parentStreamId) continue;
      const lastTurn = manifest.turns.at(-1);
      if (!lastTurn || lastTurn.kind !== 'open') continue;

      const hydrationFields = {
        sessionLinks: collectKnownSessionLinks(manifest),
        draft: getOpenTurnDraft(manifest),
        transcript: manifestToTranscript(manifest),
      };
      const basePermission = {
        requestId: manifest.threadId,
        threadId: manifest.threadId,
        question: lastTurn.question,
        context: lastTurn.context ?? undefined,
        suggestSearch: lastTurn.suggestSearch ?? undefined,
        attachFiles: lastTurn.attachFiles ?? undefined,
        allowBypass: false,
        streamId: manifest.parentStreamId,
      };
      params.externalInquiry.show(
        manifest.turns.length > 1
          ? {
              ...basePermission,
              ...hydrationFields,
              mode: 'followUp',
            }
          : {
              ...basePermission,
              ...hydrationFields,
              mode: 'new',
            },
      );
    } catch {
      // Skip unreadable manifests; the inquiry list sync logs storage damage.
    }
  }
}

export async function hydrateProgressViewInquiries(
  params: ProgressInquiryHydrationParams,
): Promise<void> {
  await Promise.all([
    syncProgressInquiryThreads(params),
    hydrateOpenInquiryPermissions(params),
  ]);
}
