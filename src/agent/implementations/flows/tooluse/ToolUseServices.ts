import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { FinalTool } from '@agent/types/ModelHandlerContracts';
import type { SubagentProgressUpdate } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files/taskRunStorage';
import type { PreparedShared, ToolUseRunShared } from './nodes/types';

export interface ToolUseServices<C = unknown> extends BaseFlowContextInit<C> {
  readonly setting: AgentToolUseSetting;
  readonly session: IToolUseSession;
  /** Run-storage-aware file locator; used to attach follow-up media files. */
  readonly fileService: TaskRunFileService;
  readonly toolRegistry: IToolRegistry;
  /** Terminal tool available for the optional provider-native final turn. */
  readonly finalTool?: FinalTool;
  readonly resumeShared: PreparedShared | null;
  readonly onFollowUpConsumed?: () => void;
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** Read the run-local terminal result so the cycle can persist it atomically. */
  readonly getPendingStructuredOutput?: () => ToolUseRunShared['structured'];
  /** Report assistant text produced by a non-skipped cycle in this invocation. */
  readonly onCycleResponse?: (response: string) => void;
  /** True when this agent was launched as a subagent by an orchestrator. */
  readonly isSubagent?: boolean;
  /**
   * Root-run-only notification: fires with the latest assistant response at
   * every cycle boundary (not just a genuine block), before the flow either
   * continues immediately (a follow-up is already queued) or blocks on
   * `session.waitForFollowUp()`. Used by hosts that project a live
   * transcript outside the flow's own event stream — e.g. the CLI syncing
   * its terminal transcript. Never fires in subagent mode, which has its own
   * WAITING-suspend delivery path instead.
   */
  readonly onIdle?: (lastResponse: string | undefined) => void;
}
