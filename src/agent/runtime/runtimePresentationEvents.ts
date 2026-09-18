import { Data } from 'effect';

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

/**
 * Why the host could not read a file's diagnostics for the diagnostics tool.
 *
 * Read off the one implementation
 * (`packages/extension/src/frontend/latex/linter.ts`): the LaTeX build the
 * read triggers to refresh them faults (`build-failed`), or the host's own
 * diagnostics collection throws (`read-failed`).
 */
export class DiagnosticsReadFailed extends Data.TaggedError(
  'DiagnosticsReadFailed',
)<{
  readonly reason: 'build-failed' | 'read-failed';
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A host could not present one runtime notice: its `emit` threw, or the
 * promise it answered with rejected. The presentation plane's one failure, so
 * the fallback notice and the warn logs that consume it report the same cause
 * the raw `catch` they replaced reported.
 */
export class HostPresentationFailed extends Data.TaggedError(
  'HostPresentationFailed',
)<{
  readonly event: RuntimePresentationEvent;
  readonly cause: unknown;
}> {}

/**
 * The host viewer refused to open a PDF the tool had already located on disk.
 * One reason only, by measurement: the implementation hands the file to the
 * host's own viewer, which either opens it or rejects.
 */
export class PdfOpenFailed extends Data.TaggedError('PdfOpenFailed')<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
