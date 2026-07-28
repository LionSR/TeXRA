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
