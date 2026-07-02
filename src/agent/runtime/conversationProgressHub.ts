/**
 * Bridge a run's `conversationProgress` domain events to its host's
 * `updateConversationProgress` UI event — the single derivation point (F-1b)
 * for both agent categories. Workflow and tool-use flows count turns
 * differently (round index vs. tool-call-bearing overview updates) and keep
 * computing their own numbers via {@link logConversationProgress}; this hub
 * is the only place that turns that single producer emission into the host
 * event, replacing the two call sites that used to call `runtimeHost.emit`
 * directly from `executeAgent.ts`.
 */
import type { AgentTrace } from '@agent/trace';
import type { ConversationProgress, StreamTabId } from '@shared/schemas';

import type { AgentRuntimeHost } from './AgentRuntimeHost';

/** Returns a detach disposer; callers bundle it into the run's trace teardown. */
export function attachConversationProgressHub(
  trace: AgentTrace,
  runtimeHost: AgentRuntimeHost,
  streamId: StreamTabId,
): () => void {
  return trace.subscribe((event) => {
    if (event.type !== 'domain' || event.key !== 'conversationProgress') {
      return;
    }
    runtimeHost.emit('updateConversationProgress', {
      streamId,
      progress: event.data as ConversationProgress,
    });
  });
}
