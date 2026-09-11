import type {
  RequestEnsureProgressViewPayload,
  RequestOpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  ShowAgentConfigBannerPayload,
} from '@shared/schemas';

/**
 * Host-presentation requests emitted by agent/runtime code.
 *
 * These are not progress facts and do not belong to the frozen host progress
 * compatibility vocabulary. Hosts may render them, ignore them, or route them
 * to their own presentation channel without changing the agent loop.
 * Presentation is fire-and-forget: a host that cannot render an event logs
 * the cause itself.
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
   * Shown through `requestShowError` on the same host when presenting this
   * event throws, live or on replay: for a notice that is a failure's only
   * surface.
   */
  readonly fallbackMessage?: string;
}

/**
 * One handler per {@link RuntimePresentationEventPayloads} key, each typed to
 * that event's own payload. A host builds this as an object literal and
 * dispatches with `handlers[event](payload)` from a generic
 * `emit<K extends RuntimePresentationEvent>`: the mapped type correlates the
 * handler to the key, so no per-event `payload as Payloads['x']` cast is
 * needed, and omitting a key is a compile error rather than a dropped event.
 */
export type PresentationEventHandlers<
  Payloads = RuntimePresentationEventPayloads,
> = {
  [K in keyof Payloads]: (payload: Payloads[K]) => unknown;
};
