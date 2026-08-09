import type { AgentTrace } from '@agent/trace';
import type {
  ExternalInquiryPermission,
  InquiryThreadUpdatedEvent,
} from '@shared/schemas';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';
import {
  getOpenTurnDraft,
  listThreadsByStatus,
  manifestToTranscript,
  readExternalInquiryThread,
} from '@tools/inquiry/externalInquiryStorage';

import { ApprovalRequestHandler } from './ApprovalRequestHandler';

const MAX_INQUIRY_THREADS = 100;

export interface ExternalInquiryRequestHandlerOptions {
  show: (permission: ExternalInquiryPermission) => void;
  dismiss: (requestId: string) => void;
  syncThreads: (threads: InquiryThreadUpdatedEvent[]) => void;
  canSend: () => boolean;
  logger?: Pick<AgentTrace, 'debug'>;
}

/**
 * Owns both live and durable external-inquiry delivery. Unlike transient
 * approvals, external inquiries survive a host restart, so normal webview
 * replay also reconciles the handler with storage.
 */
export class ExternalInquiryRequestHandler extends ApprovalRequestHandler<
  ExternalInquiryPermission,
  'requestId'
> {
  constructor(private readonly options: ExternalInquiryRequestHandlerOptions) {
    super('requestId', options.show, options.dismiss, options.canSend);
  }

  override async replay(): Promise<void> {
    if (!this.options.canSend()) return;

    await Promise.all([this.syncThreadList(), this.replayOpenPermissions()]);
    super.replay();
  }

  private async syncThreadList(): Promise<void> {
    try {
      const threads = await listThreadsByStatus({
        status: 'any',
        scope: 'all',
        limit: MAX_INQUIRY_THREADS,
      });
      this.options.syncThreads(threads);
    } catch (error) {
      // Inquiry history is auxiliary state; pending prompts must still replay.
      this.options.logger?.debug(`Failed to list inquiry threads: ${error}`);
    }
  }

  private async replayOpenPermissions(): Promise<void> {
    const open = await listThreadsByStatus({
      status: 'open',
      scope: 'all',
    }).catch((error) => {
      this.options.logger?.debug(
        `Failed to list open inquiry threads: ${error}`,
      );
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

        const basePermission = {
          requestId: manifest.threadId,
          threadId: manifest.threadId,
          question: lastTurn.question,
          context: lastTurn.context ?? undefined,
          suggestSearch: lastTurn.suggestSearch ?? undefined,
          attachFiles: lastTurn.attachFiles ?? undefined,
          allowBypass: false,
          streamId: manifest.parentStreamId,
          sessionLinks: collectKnownSessionLinks(manifest),
          draft: getOpenTurnDraft(manifest),
          transcript: manifestToTranscript(manifest),
        };
        this.stagePresentationForReplay(
          manifest.turns.length > 1
            ? { ...basePermission, mode: 'followUp' }
            : { ...basePermission, mode: 'new' },
        );
      } catch (error) {
        // Skip unreadable manifests; the thread-list read reports valid peers.
        this.options.logger?.debug(
          `Failed to replay inquiry thread ${summary.threadId}: ${error}`,
        );
      }
    }
  }
}
