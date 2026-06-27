import type {
  ExternalInquiryPermission,
  ExternalInquiryThreadSummary,
  InquiryThreadStatus,
  StreamTabId,
} from '@shared/schemas';
import { collectKnownSessionLinks } from '@tools/inquiry/externalInquiryResultFormatter';
import {
  getOpenTurnDraft,
  listOpenThreads,
  listThreadsByStatus,
  manifestToTranscript,
  readExternalInquiryThread,
  type ExternalInquiryThreadManifest,
} from '@tools/inquiry/externalInquiryStorage';

export interface RuntimeExternalInquiryThreadListRequest {
  readonly status: InquiryThreadStatus | 'any';
  readonly scope: 'stream' | 'all';
  readonly streamId?: StreamTabId;
  readonly limit?: number;
  readonly since?: string;
}

export function listRuntimeExternalInquiryThreads(
  request: RuntimeExternalInquiryThreadListRequest,
): Promise<ExternalInquiryThreadSummary[]> {
  return listThreadsByStatus(request);
}

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
