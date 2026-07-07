import process from 'node:process';

import type { AgentEvent } from '@agent/trace';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';

import {
  emitProjectedProgressEvent,
  projectSessionFactToProgressEvent,
} from './sessionProgressEventProjection';
import type { AgentRuntimeHost } from './AgentRuntimeHost';

const logger = createChannelTrace('SessionEventHub');

export type SessionFact =
  | {
      readonly type: 'goalStateChanged';
      readonly payload: ProgressEventPayloads['goalStateChanged'];
    }
  | {
      readonly type: 'inquiryThreadUpdated';
      readonly payload: ProgressEventPayloads['inquiryThreadUpdated'];
    }
  | {
      readonly type: 'clearMissingOutputs';
      readonly payload: ProgressEventPayloads['clearMissingOutputs'];
    }
  | {
      readonly type: 'updateQueuedFollowUps';
      readonly payload: ProgressEventPayloads['updateQueuedFollowUps'];
    }
  | {
      readonly type: 'setActiveStream';
      readonly payload: ProgressEventPayloads['setActiveStream'];
    };

export type SessionEvent =
  | { scope: 'run'; streamId: StreamTabId; event: AgentEvent }
  | { scope: 'session'; event: SessionFact };

/**
 * Re-emit a {@link SessionFact} on the legacy per-host progress-event
 * surface. This keeps host-channel callers on the same neutral projection as
 * any host-owned hub subscription.
 */
export function emitLegacySessionFactOnHost(
  host: AgentRuntimeHost,
  fact: SessionFact,
): void {
  emitProjectedProgressEvent(host, projectSessionFactToProgressEvent(fact));
}

export interface SessionEventSubscriptionFilter {
  readonly scope?: SessionEvent['scope'];
  readonly streamId?: StreamTabId;
  readonly types?: readonly AgentEvent['type'][];
}

export type SessionEventSubscriber = (event: SessionEvent) => void;

interface SubscriberRegistration {
  readonly subscriber: SessionEventSubscriber;
  readonly scope?: SessionEvent['scope'];
  readonly streamId?: StreamTabId;
  readonly types?: ReadonlySet<AgentEvent['type']>;
}

function isDevAssertionMode(): boolean {
  return (
    process.env.NODE_ENV === 'test' || process.env.TEXRA_DEV_ASSERTIONS === '1'
  );
}

/**
 * Session-scoped one-way fact hub. Filters are applied before subscriber
 * callbacks so high-volume stream chunks only reach consumers that explicitly
 * asked for them.
 */
export class SessionEventHub {
  private readonly subscribers = new Set<SubscriberRegistration>();
  private runScopeSubscriberCount = 0;
  private readonly runScopeSubscriberCountsByStream = new Map<
    StreamTabId,
    number
  >();

  emit(event: SessionEvent): void {
    for (const registration of this.subscribers) {
      if (registration.scope && registration.scope !== event.scope) continue;
      if (
        registration.streamId &&
        (event.scope !== 'run' || registration.streamId !== event.streamId)
      ) {
        continue;
      }
      if (
        registration.types &&
        (event.scope !== 'run' || !registration.types.has(event.event.type))
      ) {
        continue;
      }
      try {
        registration.subscriber(event);
      } catch (err) {
        logger.warn('Session event subscriber threw', { data: err });
      }
    }
  }

  subscribe(
    subscriber: SessionEventSubscriber,
    filter: SessionEventSubscriptionFilter = {},
  ): () => void {
    const registration: SubscriberRegistration = {
      subscriber,
      scope: filter.scope,
      streamId: filter.scope === 'session' ? undefined : filter.streamId,
      types: filter.types ? new Set(filter.types) : undefined,
    };
    this.subscribers.add(registration);
    if (registration.scope !== 'session') {
      if (registration.streamId) {
        this.runScopeSubscriberCountsByStream.set(
          registration.streamId,
          (this.runScopeSubscriberCountsByStream.get(registration.streamId) ??
            0) + 1,
        );
      } else {
        this.runScopeSubscriberCount += 1;
      }
    }

    return () => {
      if (!this.subscribers.delete(registration)) return;
      if (registration.scope !== 'session' && registration.streamId) {
        const nextCount =
          (this.runScopeSubscriberCountsByStream.get(registration.streamId) ??
            1) - 1;
        if (nextCount > 0) {
          this.runScopeSubscriberCountsByStream.set(
            registration.streamId,
            nextCount,
          );
        } else {
          this.runScopeSubscriberCountsByStream.delete(registration.streamId);
        }
      } else if (registration.scope !== 'session') {
        this.runScopeSubscriberCount -= 1;
      }
    };
  }

  /**
   * Dev/test guard for startup-resume ordering: run-scoped subscribers must be
   * attached before a launch activates the stream. Production logs the
   * violation so startup can continue; tests and opt-in dev runs throw.
   */
  assertRunSubscribersAttachedBeforeActivation(streamId: StreamTabId): void {
    if (
      this.runScopeSubscriberCount > 0 ||
      (this.runScopeSubscriberCountsByStream.get(streamId) ?? 0) > 0
    ) {
      return;
    }

    const message = `No run-scoped session event subscribers attached for ${streamId} before activation`;
    if (isDevAssertionMode()) {
      throw new Error(message);
    }
    logger.warn(message);
  }
}
