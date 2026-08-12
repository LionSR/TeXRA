/** Shared helper functions for ReflectionFlow nodes. */

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { AgentWorkspaceSnapshot } from '@agent/core/state/AgentWorkspaceState';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { FileLocation, RoundOutput } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files/taskRunStorage';

/** Get files to process for a round (input files for round 0, previous outputs otherwise). */
export function getFilesForRound(
  currentRound: number,
  roundOutputs: RoundOutput[],
  config: AgentConfig,
  fileService: TaskRunFileService,
): FileLocation[] {
  if (currentRound === 0) {
    // First round: process input files
    return config.inputFiles.map((f) => fileService.createLocation(f));
  }

  // Subsequent rounds: process previous round's output files
  const prevOutput = roundOutputs[currentRound - 1];
  if (prevOutput?.outputs.length) {
    return prevOutput.outputs.map((o) => o.location);
  }

  // Fallback to configured output files
  if (config.outputFiles.length) {
    return config.outputFiles.map((f) => fileService.createLocation(f));
  }

  return [];
}

/**
 * Rebuild the workspace from a snapshot this flow produced itself —
 * `toSnapshot()` output from the previous round (or the one-time resume
 * hydration in `runReflectionFlow`) — never raw persisted/legacy data. Node
 * prep must always take this canonical-only path so the legacy migration arm
 * of `AgentWorkspaceState.fromSnapshot` is never re-evaluated mid-flow.
 */
export function workspaceFromSnapshot(
  snapshot: AgentWorkspaceSnapshot,
): AgentWorkspaceState {
  return AgentWorkspaceState.fromCanonicalSnapshot(snapshot);
}
