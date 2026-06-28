// Resolve what `texra resume <id>` should continue.
//
// Resume = continue (load the prior conversation), not re-run. The resumable
// state lives in the per-execution flow record (executions/<id>/flow-*.json),
// written per-step during a tool-use run; the runtime resume command rebuilds
// a full snapshot (messages + state slices) from it. Only tool-use agents
// resume this way — workflows are not continuable here.

import type { RuntimeAgentConfig } from '@agent/runtime/executionRequests';
import {
  readRuntimeToolUseResumeDataForConfig,
  type RuntimeToolUseSessionSnapshot,
} from '@agent/runtime/resumeCommands';
import { toErrorMessage } from '@common/errors';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import { readCliHistoryConfig } from './history';

export type CliResumeResolution =
  | {
      readonly kind: 'toolUse';
      readonly snapshot: RuntimeToolUseSessionSnapshot;
      readonly streamId: StreamTabId;
      readonly config: RuntimeAgentConfig;
    }
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
  let config: RuntimeAgentConfig | null;
  try {
    config = await readCliHistoryConfig(id);
  } catch (error) {
    return { kind: 'load-failed', reason: toErrorMessage(error) };
  }
  if (!config) return { kind: 'not-found' };

  const resume = await readRuntimeToolUseResumeDataForConfig({
    executionId: id,
    config,
  });
  switch (resume.status) {
    case 'not_tool_use':
      return { kind: 'workflow' };
    case 'not_resumable':
      return { kind: 'no-snapshot' };
    case 'failed':
      return { kind: 'load-failed', reason: resume.message };
    case 'resumable':
      return {
        kind: 'toolUse',
        snapshot: resume.data.snapshot,
        streamId: resume.data.streamId,
        config: resume.data.config,
      };
  }
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
