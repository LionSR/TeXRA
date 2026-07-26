import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';

export interface AgentRuntimeEmitOptions {
  /** Retain a presentation event until a temporarily detached UI returns. */
  readonly replayWhenAttached?: boolean;
}

/**
 * The direct host-event sink the agent core emits through during a run. Hosts
 * (VS Code extension, CLI, desktop, or an SDK embedder) implement `emit` and
 * route presentation requests to their UI / transport.
 *
 * **Headless / SDK contract.** Every event is frontend-bound and ignorable:
 * `requestOpenFile`, `requestShowInstruction`, `showAgentConfigBanner`,
 * `requestShowError`, and `requestEnsureProgressView` have no effect on the
 * agent loop. Response-bearing requests use `HostInteractions`, not this
 * presentation surface.
 *
 * {@link noopAgentRuntimeHost} (drop everything) is a valid host — it is used
 * by tests and non-interactive paths.
 */
export interface AgentRuntimeHost {
  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
    options?: AgentRuntimeEmitOptions,
  ): void;
}

export const noopAgentRuntimeHost: AgentRuntimeHost = Object.freeze({
  emit: () => {},
});
