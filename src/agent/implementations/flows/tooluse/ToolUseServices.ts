import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';
import type { SubagentProgressUpdate, TodoItem } from '@shared/schemas';
import type {
  BaseFlowContextInit,
  FlowParams,
} from '../common/BaseFlowServices';
import type { IToolUseSession } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';

export interface ToolUseServices<C = unknown> extends BaseFlowContextInit<C> {
  readonly setting: AgentToolUseSetting;
  readonly session: IToolUseSession;
  readonly resolvedTools: ToolDefinition[];
  readonly toolRegistry: IToolRegistry;
  readonly snapshot: ToolUseSessionSnapshot | null;
  readonly onRoundFinalized: RoundFinalizedCallback;
  readonly onFollowUpConsumed?: () => void;
  readonly onBeforeWaiting?: (
    lastResponse: string | undefined,
    touchedFiles: string[],
  ) => void | Promise<void>;
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** Persist todos to the execution KV store. Injected by runToolUseFlow. */
  readonly persistTodos?: (todos: TodoItem[]) => Promise<void>;
  /** True when this agent was launched as a subagent by an orchestrator. */
  readonly isSubagent?: boolean;
  /**
   * True when the agent's YAML requested delegation tools but they were filtered
   * out by the current delegation-depth gate. The prepare node uses this to
   * tell the LLM it cannot delegate further.
   */
  readonly delegationTrimmed?: boolean;
}

export type { FlowParams as ToolUseFlowParams };
