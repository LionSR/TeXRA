// Local imports - state components
import { RoundMetricsState } from './RoundMetricsState';
import { RunMetricsState } from './RunMetricsState';
import { ToolRuntimeStore } from './ToolRuntimeStore';

/**
 * Typed shared store aligned with Pocket Flow design.
 *
 * This interface exposes a structured "shared store" surface that composes metrics
 * and tool runtime state under well-named keys, making it explicit which node owns
 * which slice of state. This aligns with Pocket Flow's documented "shared" store
 * abstraction pattern.
 */
export interface AgentSharedStore {
  /** Metrics for the current round */
  roundMetrics: RoundMetricsState;

  /** Aggregated metrics across all rounds */
  runMetrics: RunMetricsState;

  /** Tool runtime state (scratchpad, media, reasoning) */
  toolRuntime: ToolRuntimeStore;

  /** Output file path tracked by the flow */
  outputFile: string;
}

/**
 * Creates a new agent shared store with initialized state.
 *
 * @param currRound - The current round number for initializing round metrics
 * @param outputFile - The output file path for this execution
 * @returns A fully initialized shared store
 */
export function createAgentSharedStore(
  currRound: number,
  outputFile: string,
): AgentSharedStore {
  return {
    roundMetrics: new RoundMetricsState(currRound),
    runMetrics: new RunMetricsState(),
    toolRuntime: new ToolRuntimeStore(),
    outputFile,
  };
}

/**
 * Converts shared store to a serializable object for persistence.
 */
export function serializeAgentSharedStore(
  store: AgentSharedStore,
): Record<string, any> {
  return {
    roundMetrics: store.roundMetrics.toObject(),
    runMetrics: store.runMetrics.toObject(),
    toolRuntime: store.toolRuntime.toObject(),
    outputFile: store.outputFile,
  };
}

/**
 * Reconstructs a shared store from a persisted state object.
 */
export function deserializeAgentSharedStore(
  stateObj: Record<string, any> | null,
): AgentSharedStore {
  if (!stateObj) {
    return createAgentSharedStore(0, '');
  }

  return {
    roundMetrics: RoundMetricsState.fromObject(stateObj.roundMetrics ?? null),
    runMetrics: RunMetricsState.fromObject(stateObj.runMetrics ?? null),
    toolRuntime: ToolRuntimeStore.fromObject(stateObj.toolRuntime ?? null),
    outputFile: stateObj.outputFile ?? '',
  };
}
