import type { StreamTabId } from '@shared/schemas';
import { cleanupAllApprovals, releaseStreamResources } from '@tools/approval';

/** Release runtime-owned resources for one deleted stream. */
export function releaseRuntimeStreamResources(streamId: StreamTabId): void {
  releaseStreamResources(streamId);
}

/** Clear process-wide approval state for the single-session extension host. */
export function cleanupRuntimeApprovalsForAllStreams(): void {
  cleanupAllApprovals();
}
