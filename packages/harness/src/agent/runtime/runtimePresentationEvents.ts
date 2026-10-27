import { type Effect, Schema } from 'effect';

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

/** The name of a presentation event the runtime asks a host to show. */
export type RuntimePresentationEvent = keyof RuntimePresentationEventPayloads;

/** Every event name, as {@link HostPresentationFailed} records it. */
const RuntimePresentationEventSchema = Schema.Literals([
  'requestOpenFile',
  'requestShowInstruction',
  'showAgentConfigBanner',
  'requestShowError',
  'requestEnsureProgressView',
] as const satisfies readonly RuntimePresentationEvent[]);

/** How a presentation event is delivered when no host is attached, or when
 *  the host fails to present it. */
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
 * What a host answers an `emit` with: the program that presents the notice,
 * or nothing when the host already presented it. Presentation is
 * fire-and-forget, so the runtime forks that program and reports its
 * failure — which is why a host hands it over rather than running a fiber
 * of its own.
 */
export type HostPresentation = Effect.Effect<void, Error> | void;

/**
 * One handler per {@link RuntimePresentationEventPayloads} key, each typed to
 * that event's own payload. A host builds this as an object literal and
 * dispatches with `handlers[event](payload)` from a generic
 * `emit<K extends RuntimePresentationEvent>`: the mapped type correlates the
 * handler to the key, so no per-event `payload as Payloads['x']` cast is
 * needed, and omitting a key is a compile error rather than a dropped event.
 * `Result` is what the host's own dispatch answers with — {@link
 * HostPresentation} for a host behind `HostInteractions.emit`.
 */
export type PresentationEventHandlers<
  Payloads = RuntimePresentationEventPayloads,
  Result = unknown,
> = {
  [K in keyof Payloads]: (payload: Payloads[K]) => Result;
};

/**
 * A host could not present one runtime notice: its `emit` threw. The
 * presentation plane's one failure, so the fallback notice and the warn logs
 * that consume it report the same cause the raw `catch` they replaced
 * reported. A failure of the program `emit` answers with is not this one:
 * nothing waits on a presentation, so `presentOn` warn-logs it on the
 * detached fiber that runs it and no `fallbackMessage` follows.
 */
export class HostPresentationFailed extends Schema.TaggedError<HostPresentationFailed>()(
  'HostPresentationFailed',
  {
    event: RuntimePresentationEventSchema,
    cause: Schema.Defect(),
  },
) {}
