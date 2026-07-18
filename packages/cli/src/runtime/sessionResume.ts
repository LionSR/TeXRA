// Resolve what `texra resume <id>` should continue.
//
// Resume = continue (load the prior conversation), not re-run. The resumable
// state lives in the per-execution flow record (executions/<id>/flow-*.json),
// written per-step during a tool-use run; `retrieveSessionResumeData` rebuilds
// a full snapshot (messages + state slices) from it. Only tool-use agents
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
  | (ToolUseResumeData & { readonly kind: 'toolUse' })
  /** A workflow execution — not continuable via the tool-use snapshot path. */
  | { readonly kind: 'workflow' }
  /** No execution with this id. */
  | { readonly kind: 'not-found' }
  /** Tool-use, but no live flow record to continue from (completed or cleared). */
  | { readonly kind: 'no-snapshot' }
  /** Execution metadata or resume state exists but could not be loaded. */
  | { readonly kind: 'load-failed'; readonly reason: string };

export type CliToolUseResumeResolution = Extract<
  CliResumeResolution,
  { readonly kind: 'toolUse' }
>;

export async function resolveCliResumeSnapshot(
  id: ExecutionId,
): Promise<CliResumeResolution> {
  let config: AgentConfig | null;
  try {
    config = await readCliHistoryConfig(id);
  } catch (error) {
    return { kind: 'load-failed', reason: toErrorMessage(error) };
  }
  if (!config) return { kind: 'not-found' };

  const taskState = agentConfigToTaskState(config);
  if (!isToolUseTaskState(taskState)) return { kind: 'workflow' };

  let resume: ToolUseResumeData | null;
  try {
    resume = await readCliToolUseResumeData(id, config);
  } catch (error) {
    return { kind: 'load-failed', reason: toErrorMessage(error) };
  }
  if (!resume) return { kind: 'no-snapshot' };

  return {
    kind: 'toolUse',
    ...resume,
  };
}

/** A user-facing line explaining why a non-tool-use resolution can't continue. */
export function explainNonResumable(
  resolution: Exclude<CliResumeResolution, { kind: 'toolUse' }>,
  id: ExecutionId,
): string {
  switch (resolution.kind) {
    case 'not-found':
      return `Execution not found: ${id}`;
    case 'workflow':
      return `Execution ${id} is a workflow; only tool-use sessions can be resumed.`;
    case 'no-snapshot':
      return `Execution ${id} has no resumable session state (it completed or was cleared).`;
    case 'load-failed':
      return `Failed to load resumable session ${id}: ${resolution.reason}`;
  }
}
