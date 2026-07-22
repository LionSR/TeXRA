import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import type { RuntimePresentationEventPayloads } from '@agent/runtime/runtimePresentationEvents';

export type AgentRuntimeEventPayloads = RuntimeInteractionEventPayloads &
  RuntimePresentationEventPayloads;

export type AgentRuntimeEvent = keyof AgentRuntimeEventPayloads;

/**
 * The direct host-event sink the agent core emits through during a run. Hosts
 * (VS Code extension, CLI, desktop, or an SDK embedder) implement `emit` and
 * route interaction and presentation requests to their UI / transport.
 *
 * **Headless / SDK contract.** Not every event is required for execution. A
 * headless consumer can implement a partial host and safely ignore the
 * UI-oriented events — the run completes regardless. Two tiers:
 *
 * - **Host interaction surface** (`RuntimeInteractionEventPayloads`): typed
 *   approval and user-question requests that may affect the agent loop.
 * - **Frontend-bound, ignorable** (`RuntimePresentationEventPayloads`):
 *   `requestOpenFile`, `requestShowInstruction`, `showAgentConfigBanner`,
 *   `requestShowError`, `requestEnsureProgressView`, pure host-UI requests
 *   with no effect on the agent loop.
 *
 * {@link noopAgentRuntimeHost} (drop everything) is a valid host — it is used
 * by tests and non-interactive paths.
 */
export interface AgentRuntimeHost {
  emit<K extends AgentRuntimeEvent>(
    event: K,
    payload: AgentRuntimeEventPayloads[K],
  ): void;
}

export const noopAgentRuntimeHost: AgentRuntimeHost = Object.freeze({
  emit: () => {},
});
