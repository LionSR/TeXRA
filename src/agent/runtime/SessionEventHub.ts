import process from 'node:process';

import type { AgentEvent } from '@agent/trace';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';

const logger = createChannelTrace('SessionEventHub');

export type SessionFact = never;

export type SessionEvent =
  | { scope: 'run'; streamId: StreamTabId; event: AgentEvent }
  | { scope: 'session'; event: SessionFact };

export interface SessionEventSubscriptionFilter {
  readonly scope?: SessionEvent['scope'];
  readonly types?: readonly AgentEvent['type'][];
}

export type SessionEventSubscriber = (event: SessionEvent) => void;

interface SubscriberRegistration {
  readonly subscriber: SessionEventSubscriber;
  readonly scope?: SessionEvent['scope'];
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

  emit(event: SessionEvent): void {
    for (const registration of this.subscribers) {
      if (registration.scope && registration.scope !== event.scope) continue;
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
      types: filter.types ? new Set(filter.types) : undefined,
    };
    this.subscribers.add(registration);
    if (filter.scope !== 'session') {
      this.runScopeSubscriberCount += 1;
    }

    return () => {
      if (!this.subscribers.delete(registration)) return;
      if (filter.scope !== 'session') {
        this.runScopeSubscriberCount -= 1;
      }
    };
  }

  /**
   * Dev/test guard for startup-resume ordering: run-scoped projectors must be
   * attached before a launch activates the stream. Production logs the
   * violation so startup can continue; tests and opt-in dev runs throw.
   */
  assertRunSubscribersAttachedBeforeActivation(streamId: StreamTabId): void {
    if (this.runScopeSubscriberCount > 0) return;

    const message = `No run-scoped session event subscribers attached before activating ${streamId}`;
    if (isDevAssertionMode()) {
      throw new Error(message);
    }
    logger.warn(message);
  }
}
