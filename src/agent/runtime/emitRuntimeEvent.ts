/**
 * Single emit path for run/host progress events (SDK Step 7d follow-on F-1).
 *
 * Replaces scattered `ProgressEventBus.emit(...)` in `src/tools` so one fact
 * has one emit path and one name, resolving the target in priority order:
 *
 * 1. migrated Stage 3a facts go to the owning `SessionEventHub`, where
 *    host-owned subscribers can project them with `sessionProgressEventProjection`;
 * 2. a host-path caller's `session.hostChannel` (set only by hosts that own a
 *    non-default session, e.g. a desktop window) — when present;
 * 3. otherwise the active run's `runtimeHost`, resolved from the ambient
 *    {@link RunContext} (the in-run case — tools firing inside a run's ALS);
 * 4. otherwise the process {@link ProgressEventBus} — the single-session
 *    fallback that keeps the extension byte-identical (its run
 *    `runtimeHost.emit` is `ProgressEventBus.emit` anyway) and host-path
 *    callers that pass no session unchanged.
 *
 * In-run callers pass no `session` (the ALS supplies the run host). Host-path
 * callers — reachable outside any run ALS — MUST pass their owning `session`,
 * or the event resolves to the bus and a non-default session never sees it.
 */
import {
  ProgressEventBus,
  type ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

import { tryUseRunContext } from './RunContext';
import { defaultSession, type SessionHandle } from './SessionHandle';
import {
  emitLegacySessionFactOnHost,
  type SessionFact,
} from './SessionEventHub';

function emitSessionFact(fact: SessionFact, session?: SessionHandle): void {
  const owner = session ?? tryUseRunContext()?.session;
  if (owner?.events) {
    owner.events.emit({ scope: 'session', event: fact });
    return;
  }
  if (owner?.hostChannel) {
    emitLegacySessionFactOnHost(owner.hostChannel, fact);
    return;
  }
  defaultSession().events.emit({ scope: 'session', event: fact });
}

export function emitRuntimeEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
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

  const host = session?.hostChannel ?? tryUseRunContext()?.runtimeHost;
  if (host) host.emit(event, payload);
  else ProgressEventBus.emit(event, payload);
}
