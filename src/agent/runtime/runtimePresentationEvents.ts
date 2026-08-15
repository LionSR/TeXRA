import type {
  RequestEnsureProgressViewPayload,
  RequestOpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  ShowAgentConfigBannerPayload,
} from '@shared/schemas';

import type { HostInteractions } from './HostInteractions';

/**
 * Host-presentation requests emitted by agent/runtime code.
 *
 * These are not progress facts and do not belong to the frozen host progress
 * compatibility vocabulary. Hosts may render them, ignore them, or route them
 * to their own presentation channel without changing the agent loop.
 */
export interface RuntimePresentationEventPayloads {
  requestOpenFile: RequestOpenFilePayload;
  requestShowInstruction: RequestShowInstructionPayload;
  showAgentConfigBanner: ShowAgentConfigBannerPayload;
  requestShowError: RequestShowErrorPayload;
  requestEnsureProgressView: RequestEnsureProgressViewPayload;
}

export type RuntimePresentationEvent = keyof RuntimePresentationEventPayloads;

export interface AgentRuntimeEmitOptions {
  /** Retain a presentation event until a temporarily detached UI returns. */
  readonly replayWhenAttached?: boolean;
  /**
   * Invoked synchronously when `replayWhenAttached` retains the event because
   * no host is attached. Callers use this to record "presentation is pending"
   * without claiming it was delivered.
   */
  readonly onReplayScheduled?: () => void;
  /**
   * Invoked once a retained event is actually replayed to a host and that
   * host reports delivery. This is the only queued path that may record a
   * confirmed-presentation marker.
   */
  readonly onReplayDelivered?: () => void;
  /**
   * Invoked once a retained event is actually replayed to a host and that
   * host reports non-delivery (or rejects). The callback receives the host
   * that performed the replay so the caller can present its fallback surface
   * on the same host.
   */
  readonly onReplayNotDelivered?: (interactions: HostInteractions) => unknown;
}

/**
 * One handler per {@link RuntimePresentationEventPayloads} key, each typed to
 * that event's own payload. Building a value of this type as an object
 * literal (rather than a `switch (event) { case ... }`) is what lets
 * TypeScript correlate the map's value type to a specific key through the
 * object's own indexed-access type, instead of through a hand-written
 * `payload as Payloads['x']` cast repeated on every branch.
 */
export type PresentationEventHandlers<
  Payloads = RuntimePresentationEventPayloads,
> = {
  [K in keyof Payloads]: (payload: Payloads[K]) => unknown;
};

/**
 * Dispatches a `(event, payload)` pair — as received from a
 * `SessionHostInteractions.emit`-style call — to the matching entry of a
 * {@link PresentationEventHandlers} map.
 *
 * Every host that reacts to `RuntimePresentationEvent`s (CLI, desktop, VS
 * Code extension) used to hand-write its own
 * `switch (event) { case 'x': (payload as Payloads['x'])... }` dispatcher,
 * re-asserting the event/payload correlation with a cast on every branch.
 * Calling this instead — with `handlers` built as a
 * `PresentationEventHandlers` object literal — needs no cast: `K` narrows
 * `handlers[event]` to `(payload: Payloads[K]) => unknown` and `payload` is
 * already `Payloads[K]`, so the call typechecks structurally. This mirrors
 * the `HandlerRegistry`/`createDispatcher` idiom the progressView/
 * settingsView message dispatchers already use
 * (`src/shared/utils/dispatcher.ts`), minus the schema-parsing step those
 * need for a raw `unknown` wire message — this dispatcher's `(event,
 * payload)` pair is already typed at the call site.
 */
export function dispatchPresentationEvent<Payloads, K extends keyof Payloads>(
  handlers: PresentationEventHandlers<Payloads>,
  event: K,
  payload: Payloads[K],
): unknown {
  return handlers[event](payload);
}

/**
 * Result contract for a presentation handler that can report delivery. A
 * handler that renders the event synchronously returns `true`; a handler that
 * renders asynchronously (e.g. awaiting a webview post) returns
 * `Promise<boolean>`. Any other result means "not delivered", so callers can
 * keep a fallback surface instead of assuming best-effort delivery.
 *
 * Every handler implements this contract, not only the events a caller
 * currently marks on (`showAgentConfigBanner`, `requestShowInstruction`): a
 * handler that presented its event must say so, because the next caller to
 * mark on the result will trust it. A deliberate no-op (the CLI's
 * `requestOpenFile`, the desktop progress-view reveal) truthfully reports
 * "not delivered". Deliberate suppression by user choice — the extension's
 * "never remind again" instruction state — counts as delivered: the user
 * opted out of that surface, and the generic fallback would resurface the
 * notice through a channel they cannot suppress.
 */
export type PresentationDelivery = boolean | Promise<boolean>;

/**
 * Normalizes a {@link dispatchPresentationEvent} return value to the
 * {@link PresentationDelivery} contract. Non-boolean, non-promise results are
 * treated as not delivered.
 */
export function toPresentationDelivery(result: unknown): PresentationDelivery {
  if (typeof result === 'boolean') return result;
  if (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    return Promise.resolve(result as PromiseLike<unknown>).then(
      (delivered) => delivered === true,
    );
  }
  return false;
}
