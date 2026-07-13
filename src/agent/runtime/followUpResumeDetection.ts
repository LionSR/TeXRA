import { isInFlightPhase } from '@common/constants/streamStatus';
import type { StreamPhase } from '@shared/schemas';

/**
 * Return true when a follow-up should check persistent flow state before
 * declaring that no session can continue.
 */
export function shouldProbePersistedFlowForFollowUp(
  status: StreamPhase | undefined,
): boolean {
  return !isInFlightPhase(status);
}
