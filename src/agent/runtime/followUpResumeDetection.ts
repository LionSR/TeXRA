import type { StreamPhase } from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';

/**
 * Return true when a follow-up should check persistent flow state before
 * declaring that no session can continue.
 */
export function shouldProbePersistedFlowForFollowUp(
  status: StreamPhase | undefined,
): boolean {
  return !isInFlightPhase(status);
}
