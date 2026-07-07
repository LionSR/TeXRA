import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import type {
  BaseFlowContextInit,
  RoundFinalizedCallback,
} from '@agent/core/flows/BaseFlowServices';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { ToolDefinition } from '@model';
import type { SubagentProgressUpdate, TodoItem } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';

export type ToolUseBeforeWaitingCallback = (
  lastResponse: string | undefined,
  touchedFiles: string[],
  memoryMisses: readonly AttachedMemoryMiss[],
  /** Run cost accumulated so far, when available — lets a native subagent
   *  strategy settle the parent's usage totals if this suspended turn is
   *  later abandoned instead of resumed to completion. */
  totalCostUsd?: number,
) => boolean | void | Promise<boolean | void>;

export interface ToolUseServices<C = unknown> extends BaseFlowContextInit<C> {
  readonly setting: AgentToolUseSetting;
  readonly session: IToolUseSession;
  /** Run-storage-aware file locator; used to attach follow-up media files. */
  readonly fileService: TaskRunFileService;
  readonly resolvedTools: ToolDefinition[];
  readonly toolRegistry: IToolRegistry;
  readonly snapshot: ToolUseSessionSnapshot | null;
  readonly onRoundFinalized: RoundFinalizedCallback;
  readonly onFollowUpConsumed?: () => void;
  /** Return `false` to signal nothing was delivered to an orchestrator (the
   *  current cycle is purely internal). `true` or `void` indicates a result
   *  was delivered; on interruption the wait node uses this to mark the flow
   *  as completed rather than aborted. */
  readonly onBeforeWaiting?: ToolUseBeforeWaitingCallback;
  readonly attachedMemoryMisses?: readonly AttachedMemoryMiss[];
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** Stop after one cycle instead of waiting for a conversational follow-up. */
  readonly stopAfterCycle?: boolean;
  /** Persist todos to the execution KV store. Injected by runToolUseFlow. */
  readonly persistTodos?: (todos: TodoItem[]) => Promise<void>;
  /** True when this agent was launched as a subagent by an orchestrator. */
  readonly isSubagent?: boolean;
}
