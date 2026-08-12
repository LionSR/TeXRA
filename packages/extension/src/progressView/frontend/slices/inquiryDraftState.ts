/**
 * External-inquiry draft persistence state.
 *
 * User input (answer text) is persisted in a module-level cache keyed by
 * requestId so it survives component recreation during webview hide/show
 * cycles — the permission is replayed via ApprovalRequestHandler but the
 * component is re-mounted with fresh @state.
 *
 * Owned here (a state module, next to the slices) rather than inside the Lit
 * component so the state-handler layer (eventHandlers.ts, permissionSlice.ts)
 * can clear drafts on permission removal without reaching into a UI module.
 */

import { LRUCache } from 'lru-cache';

import type { InquiryDraft } from '@shared/schemas';
import { createBoundedIdSet } from '@utils/core/boundedIdSet';

const DRAFT_CACHE_CAP = 50;
const draftCache = new LRUCache<string, InquiryDraft>({ max: DRAFT_CACHE_CAP });
const resolvedIds = createBoundedIdSet(DRAFT_CACHE_CAP);

/** Read a persisted draft for an inquiry request, if any. */
export function getInquiryDraft(requestId: string): InquiryDraft | undefined {
  return draftCache.get(requestId);
}

/** Set (or, with `null`, clear) the persisted draft for an inquiry request. */
export function setInquiryDraft(
  requestId: string,
  draft: InquiryDraft | null,
): void {
  if (draft) {
    draftCache.set(requestId, draft);
  } else {
    draftCache.delete(requestId);
  }
}

/** True once an inquiry has been resolved/submitted; no further drafts saved. */
export function isInquiryDraftResolved(requestId: string): boolean {
  return resolvedIds.has(requestId);
}

/** Clear draft for a resolved inquiry. */
export function clearInquiryDraft(requestId: string): void {
  draftCache.delete(requestId);
  resolvedIds.add(requestId);
}
