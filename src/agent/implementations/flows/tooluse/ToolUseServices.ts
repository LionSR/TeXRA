import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { FinalTool } from '@agent/types/ModelHandlerContracts';
import type { RunId, SubagentProgressUpdate } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files/taskRunStorage';
import type { PreparedShared, ToolUseRunShared } from './nodes/types';

export interface ToolUseServices extends BaseFlowContextInit {
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
  /**
   * The launching run when this run is a delegated child; `!== undefined`
   * selects the subagent prompt variant and the WAITING-suspend delivery path.
   */
  readonly parentRunId?: RunId;
  /**
   * Root-run-only notification: fires with the latest assistant response at
   * every cycle boundary (not just a genuine block), before the flow either
   * continues immediately (a follow-up is already queued) or blocks on
   * `session.waitForFollowUp()`. Used by hosts that project a live
   * transcript outside the flow's own event stream — e.g. the CLI syncing
   * its terminal transcript. Never fires for a child run, which has its own
   * WAITING-suspend delivery path instead.
   */
  readonly onIdle?: () => void;
}
