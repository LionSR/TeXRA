import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { attachSessionProgressEventProjection } from '@agent/runtime/sessionProgressEventProjection';

/**
 * Subscribe a CLI runtime host to the session fact plane and re-emit the
 * retained host progress events that CLI consumers still read.
 */
export function attachCliSessionProgressProjection(
  events: SessionEventHub,
  runtimeHost: AgentRuntimeHost,
): () => void {
  return attachSessionProgressEventProjection(events, runtimeHost);
}
