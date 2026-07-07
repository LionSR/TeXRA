/**
 * Single emit path for session-scoped runtime facts.
 *
 * Keeps migrated runtime facts on one emit path and one name, resolving the
 * target in priority order:
 *
 * 1. a host-path caller's explicit `session`;
 * 2. the active run's `RunContext.session`;
 * 3. the process default session used by the VS Code extension and CLI.
 *
 * Host/RPC events should use the owning `AgentRuntimeHost.emit` directly. This
 * helper deliberately has no broad process-bus fallback.
 */
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { tryUseRunContext } from './RunContext';
import { defaultSession, type SessionHandle } from './SessionHandle';
import type { SessionFact } from './SessionEventHub';

type RuntimeSessionEventPayloads = {
  goalStateChanged: ProgressEventPayloads['goalStateChanged'];
  inquiryThreadUpdated: ProgressEventPayloads['inquiryThreadUpdated'];
  clearMissingOutputs: ProgressEventPayloads['clearMissingOutputs'];
  updateQueuedFollowUps: ProgressEventPayloads['updateQueuedFollowUps'];
  setActiveStream: ProgressEventPayloads['setActiveStream'];
};

type RuntimeSessionEvent = keyof RuntimeSessionEventPayloads;

function emitSessionFact(fact: SessionFact, session?: SessionHandle): void {
  const owner = session ?? tryUseRunContext()?.session;
  if (owner?.events) {
    owner.events.emit({ scope: 'session', event: fact });
    return;
  }
  defaultSession().events.emit({ scope: 'session', event: fact });
}

export function emitRuntimeEvent<K extends RuntimeSessionEvent>(
  event: K,
  payload: RuntimeSessionEventPayloads[K],
  session?: SessionHandle,
): void {
  switch (event) {
    case 'goalStateChanged':
      emitSessionFact(
        {
          type: 'goalStateChanged',
          payload: payload as ProgressEventPayloads['goalStateChanged'],
        },
        session,
      );
      return;
    case 'inquiryThreadUpdated':
      emitSessionFact(
        {
          type: 'inquiryThreadUpdated',
          payload: payload as ProgressEventPayloads['inquiryThreadUpdated'],
        },
        session,
      );
      return;
    case 'clearMissingOutputs':
      emitSessionFact(
        {
          type: 'clearMissingOutputs',
          payload: payload as ProgressEventPayloads['clearMissingOutputs'],
        },
        session,
      );
      return;
    case 'updateQueuedFollowUps':
      emitSessionFact(
        {
          type: 'updateQueuedFollowUps',
          payload: payload as ProgressEventPayloads['updateQueuedFollowUps'],
        },
        session,
      );
      return;
    case 'setActiveStream':
      emitSessionFact(
        {
          type: 'setActiveStream',
          payload: payload as ProgressEventPayloads['setActiveStream'],
        },
        session,
      );
      return;
  }
  throw new Error(
    `emitRuntimeEvent only supports session facts; use the owning runtime host for ${String(event)}`,
  );
}
