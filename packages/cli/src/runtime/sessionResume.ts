// Resolve what `texra resume <id>` should continue.
//
// Resume = continue (load the prior conversation), not re-run. The resumable
// state lives in the per-execution flow record (executions/<id>/flow-*.json),
// written per-step during a tool-use run; `retrieveSessionResumeData` returns
// canonical shared state plus its resume identity. Only tool-use agents
// resume this way — workflows are not continuable here.

import { isToolUseTaskState } from '@agent/core/state/TaskState';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ToolUseResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { readCliHistoryConfig } from './history';
import { readCliToolUseResumeData } from './toolUseResumeData';

export type CliResumeResolution =
  | ToolUseResumeData
  /** A workflow execution — not continuable via the tool-use resume path. */
  | { readonly type: 'workflow' }
  /** No execution with this id. */
  | { readonly type: 'not-found' }
  /** Tool-use, but no live flow record to continue from (completed or cleared). */
  | { readonly type: 'no-resume-state' }
  /** Execution metadata or resume state exists but could not be loaded. */
  | { readonly type: 'load-failed'; readonly reason: string };

export type CliToolUseResumeResolution = Extract<
  CliResumeResolution,
  { readonly type: 'toolUse' }
>;

export async function resolveCliResume(
  id: ExecutionId,
): Promise<CliResumeResolution> {
  let config: AgentConfig | null;
  try {
    config = await readCliHistoryConfig(id);
  } catch (error) {
    return { type: 'load-failed', reason: toErrorMessage(error) };
  }
  if (!config) return { type: 'not-found' };

  const taskState = agentConfigToTaskState(config);
  if (!isToolUseTaskState(taskState)) return { type: 'workflow' };

  let resume: ToolUseResumeData | null;
  try {
    resume = await readCliToolUseResumeData(id, config);
  } catch (error) {
    return { type: 'load-failed', reason: toErrorMessage(error) };
  }
  if (!resume) return { type: 'no-resume-state' };

  return resume;
}

/** A user-facing line explaining why a non-tool-use resolution can't continue. */
export function explainNonResumable(
  resolution: Exclude<CliResumeResolution, { type: 'toolUse' }>,
  id: ExecutionId,
): string {
  switch (resolution.type) {
    case 'not-found':
      return `Execution not found: ${id}`;
    case 'workflow':
      return `Execution ${id} is a workflow; only tool-use sessions can be resumed.`;
    case 'no-resume-state':
      return `Execution ${id} has no resumable session state (it completed or was cleared).`;
    case 'load-failed':
      return `Failed to load resumable session ${id}: ${resolution.reason}`;
  }
}
