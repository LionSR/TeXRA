import type { AgentRuntimeProgressEventPayloads } from '@agent/runtime/agentRuntimeProgressEvents';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import type { RuntimePresentationEventPayloads } from '@agent/runtime/runtimePresentationEvents';
import type { HostInteractions } from './HostInteractions';

export type AgentRuntimeEventPayloads = AgentRuntimeProgressEventPayloads &
  RuntimeInteractionEventPayloads &
  RuntimePresentationEventPayloads;

export type AgentRuntimeEvent = keyof AgentRuntimeEventPayloads;

/**
 * The single progress sink the agent core emits through during a run. Hosts
 * (VS Code extension, CLI, desktop, or an SDK embedder) implement `emit` and
 * route events to their UI / transport.
 *
 * **Headless / SDK contract.** Not every event is required for execution. A
 * headless consumer can implement a partial host and safely ignore the
 * UI-oriented events — the run completes regardless. Two tiers:
 *
 * - **Essential streaming surface** (handle these to observe a run): stream
 *   lifecycle (`setActiveStream`, `updateStreamStatus`, `updateStreamUsage`,
 *   `setTaskState`), output/compile tracking (`addOutputFiles`,
 *   `updateMissingOutputs`, `updateCompileFailures`, `clearMissingOutputs`),
 *   interaction requests (`RuntimeInteractionEventPayloads`), and conversation progress
 *   (`updateTodos`/`updatePlan`/`updateConversationProgress`). See
 *   {@link AgentRuntimeProgressEventPayloads} for the complete progress enumeration.
 * - **Frontend-bound, ignorable** (`RuntimePresentationEventPayloads`):
 *   `requestOpenFile`, `requestShowInstruction`, `showAgentConfigBanner`,
 *   `requestShowError`, `requestEnsureProgressView`, pure host-UI requests
 *   with no effect on the agent loop.
 *
 * {@link noopAgentRuntimeHost} (drop everything) is a valid host — it is used
 * by tests and non-interactive paths.
 */
export interface AgentRuntimeHost {
  readonly interactions?: HostInteractions;

  emit<K extends AgentRuntimeEvent>(
    event: K,
    payload: AgentRuntimeEventPayloads[K],
  ): void;
}

export const noopAgentRuntimeHost: AgentRuntimeHost = {
  emit: () => {},
};
