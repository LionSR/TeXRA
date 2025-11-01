// Local imports - agent metrics
import {
  RoundMetricsState,
  RunMetricsState,
} from './AgentMetricsState';
import { ToolRuntimeStore } from './ToolRuntimeStore';

export interface AgentSharedStore {
  runMetrics: RunMetricsState;
  roundMetrics: RoundMetricsState;
  toolRuntime: ToolRuntimeStore;
}

export interface AgentSharedStoreInit {
  runMetrics?: RunMetricsState;
  roundMetrics: RoundMetricsState;
  toolRuntime?: ToolRuntimeStore;
}

export function createAgentSharedStore(
  init: AgentSharedStoreInit,
): AgentSharedStore {
  return {
    runMetrics: init.runMetrics ?? new RunMetricsState(),
    roundMetrics: init.roundMetrics,
    toolRuntime: init.toolRuntime ?? new ToolRuntimeStore(),
  };
}
