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

const RUNTIME_PRESENTATION_EVENTS = [
  'requestOpenFile',
  'requestShowInstruction',
  'showAgentConfigBanner',
  'requestShowError',
  'requestEnsureProgressView',
] as const satisfies readonly RuntimePresentationEvent[];

const RuntimePresentationEventSet: ReadonlySet<string> = new Set(
  RUNTIME_PRESENTATION_EVENTS,
);

export function isRuntimePresentationEvent(
  event: string,
): event is RuntimePresentationEvent {
  return RuntimePresentationEventSet.has(event);
}
