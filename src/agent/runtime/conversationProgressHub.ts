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
import type { ConversationProgress, StreamTabId } from '@shared/schemas';
import { isObject } from '@utils/core';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionEventHub } from './SessionEventHub';

/** Narrows a domain event's untyped `data` to the shape `logConversationProgress`
 *  always sends. `DomainEvent.data` is `unknown` because the channel is a
 *  general escape hatch shared by every domain key; only this hub's own
 *  producer emits `conversationProgress`, but the check keeps a malformed or
 *  missing payload from forwarding `undefined`/partial data to the host. */
function isConversationProgress(data: unknown): data is ConversationProgress {
  return (
    isObject(data) &&
    Number.isFinite(data.conversationTurns) &&
    Number.isFinite(data.toolCallCount)
  );
}

/** Returns a detach disposer; callers bundle it into the run's trace teardown. */
export function attachConversationProgressHub(
  events: SessionEventHub,
  runtimeHost: AgentRuntimeHost,
  streamId: StreamTabId,
): () => void {
  return events.subscribe(
    (sessionEvent) => {
      if (
        sessionEvent.scope !== 'run' ||
        sessionEvent.streamId !== streamId ||
        sessionEvent.event.type !== 'domain' ||
        sessionEvent.event.key !== 'conversationProgress'
      ) {
        return;
      }
      if (!isConversationProgress(sessionEvent.event.data)) return;
      runtimeHost.emit('updateConversationProgress', {
        streamId,
        progress: sessionEvent.event.data,
      });
    },
    { scope: 'run', streamId, types: ['domain'] },
  );
}
