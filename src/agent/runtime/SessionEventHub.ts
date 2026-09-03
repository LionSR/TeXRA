import type { AgentEvent, StatusEvent } from '@agent/trace';
import { createLog } from '@logger/logUtils';
import type {
  FollowUpSentPayload,
  GoalStateChangedPayload,
  InquiryThreadUpdatedEvent,
  RemoveStreamPayload,
  SetActiveStreamPayload,
  SetParentStreamPayload,
  StreamTabId,
  UpdateQueuedFollowUpsPayload,
  UpdateStreamDescriptionPayload,
} from '@shared/schemas';

const logger = createLog('SessionEventHub');

/**
 * Session-scoped fact vocabulary. Payload-bearing arms use fact-native named
 * types from `@shared/schemas`; status reuses the canonical trace event shape
 * directly. Retained runtime-host projections derive their payloads here,
 * never the reverse. Run-scoped facts live on `AgentEvent` (trace), not here.
 */
export type SessionFact =
  | {
      readonly type: 'goalStateChanged';
      readonly payload: GoalStateChangedPayload;
    }
  | {
      readonly type: 'inquiryThreadUpdated';
      readonly payload: InquiryThreadUpdatedEvent;
    }
  | {
      readonly type: 'updateQueuedFollowUps';
      readonly payload: UpdateQueuedFollowUpsPayload;
    }
  | {
      readonly type: 'followUpSent';
      readonly payload: FollowUpSentPayload;
    }
  | {
      readonly type: 'setActiveStream';
      readonly payload: SetActiveStreamPayload;
    }
  | {
      readonly type: 'updateStreamDescription';
      readonly payload: UpdateStreamDescriptionPayload;
    }
  | StatusEvent
  | {
      readonly type: 'setParentStream';
      readonly payload: SetParentStreamPayload;
    }
  | {
      readonly type: 'removeStream';
      readonly payload: RemoveStreamPayload;
    };

export type SessionEvent =
  | { scope: 'run'; streamId: StreamTabId; event: AgentEvent }
  | { scope: 'session'; event: SessionFact };

export interface SessionEventSubscriptionFilter {
  readonly scope?: SessionEvent['scope'];
  readonly streamId?: StreamTabId;
  readonly types?: readonly AgentEvent['type'][];
}

type SessionEventSubscriber = (event: SessionEvent) => void;

interface SubscriberRegistration {
  readonly subscriber: SessionEventSubscriber;
  readonly scope?: SessionEvent['scope'];
  readonly streamId?: StreamTabId;
  readonly types?: ReadonlySet<AgentEvent['type']>;
}

/**
 * Session-scoped one-way fact hub. Filters are applied before subscriber
 * callbacks so high-volume stream chunks only reach consumers that explicitly
 * asked for them.
 */
export class SessionEventHub {
  private readonly subscribers = new Set<SubscriberRegistration>();

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

    return () => {
      this.subscribers.delete(registration);
    };
  }

  /**
   * Subscribe to run-scoped facts with the callback pre-narrowed by scope and
   * by the `types` filter, so consumers neither re-check `event.scope` nor
   * cast `event.event`. The single cast here is sound: the hub applies the
   * scope and type filters before invoking the callback.
   */
  subscribeRunFacts<T extends AgentEvent['type']>(
    subscriber: (runFact: {
      readonly streamId: StreamTabId;
      readonly event: Extract<AgentEvent, { type: T }>;
    }) => void,
    filter: {
      readonly streamId?: StreamTabId;
      readonly types: readonly T[];
    },
  ): () => void {
    return this.subscribe(
      (event) => {
        if (event.scope !== 'run') return;
        subscriber({
          streamId: event.streamId,
          event: event.event as Extract<AgentEvent, { type: T }>,
        });
      },
      { scope: 'run', streamId: filter.streamId, types: filter.types },
    );
  }

  /**
   * Subscribe to session-scoped facts with the callback pre-narrowed, so
   * consumers don't re-check `event.scope`.
   */
  subscribeSessionFacts(subscriber: (fact: SessionFact) => void): () => void {
    return this.subscribe(
      (event) => {
        if (event.scope === 'session') subscriber(event.event);
      },
      { scope: 'session' },
    );
  }

  /** Subscribe to canonical status facts on the synchronous session rail. */
  subscribeStatus(subscriber: (event: StatusEvent) => void): () => void {
    return this.subscribe(
      (event) => {
        if (event.scope === 'session' && event.event.type === 'status') {
          subscriber(event.event);
        }
      },
      { scope: 'session' },
    );
  }
}
