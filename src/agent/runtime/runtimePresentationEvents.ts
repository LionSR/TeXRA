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
  [K in keyof Payloads]: (payload: Payloads[K]) => void;
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
 * `handlers[event]` to `(payload: Payloads[K]) => void` and `payload` is
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
): void {
  handlers[event](payload);
}
