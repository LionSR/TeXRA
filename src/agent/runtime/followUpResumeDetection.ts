import { isInFlightStatus } from '@common/constants/streamStatus';
import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';

/**
 * Return true when a follow-up should check persistent flow state before
 * declaring that no session can continue.
 */
export function shouldProbePersistedFlowForFollowUp(
  status: StreamStatus | undefined,
): boolean {
  return status !== STREAM_STATUS.READY && !isInFlightStatus(status);
}
