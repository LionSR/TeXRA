/**
 * State management for output processing.
 *
 * Manages mutable state for output files across rounds, including
 * round data, storage keys, and workspace preparation.
 */

import { z } from 'zod';

import {
  FileLocationSchema,
  OutputFileInfoSchema,
  OutputXmlSummarySchema,
  type OutputFileInfo,
  type StorageKey,
} from '@shared/schemas';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { normalizeRunId } from '@common/constants/runIds';
import type { AgentLogger, AgentLogStage } from '@logger/AgentLogger';
import {
  TaskRunFileService,
  getComparablePath,
  pathToLocation,
  type FileLocation,
} from '@utils/files';

// ============================================================================
// Schemas and Types
// ============================================================================

const RoundDataSchema = z.object({
  outputs: OutputFileInfoSchema.array().prefault(() => []),
  rawOutput: FileLocationSchema.nullable().prefault(null),
  xmlSummary: OutputXmlSummarySchema.prefault(() => ({})),
});

export type RoundData = z.infer<typeof RoundDataSchema>;

/** Mutable state for output processing across rounds. */
export interface OutputState {
  rounds: Map<number, RoundData>;
  openedOutputs: Set<string>;
  storageKey: StorageKey | null;
  runPreparation: Promise<void> | null;
}

/** Dependencies needed by output utility functions. */
export interface OutputDependencies {
  agentSetting: AgentWorkflowSetting;
  agentConfig: AgentConfig;
  baseFiles: FileLocation[];
  logger: AgentLogger;
  fileService: TaskRunFileService;
  executionId: string;
  streamId: string;
}

// ============================================================================
// State Creation
// ============================================================================

/** Creates the mutable state object for output processing. */
export function createOutputState(): OutputState {
  return {
    rounds: new Map(),
    openedOutputs: new Set(),
    storageKey: null,
    runPreparation: null,
  };
}

// ============================================================================
// Stage Helper
// ============================================================================

/**
 * Wraps an operation in an output processing stage for logging.
 * Shared helper to avoid duplication across output processing modules.
 */
export async function withOutputStage<T>(
  deps: OutputDependencies,
  label: string,
  parentStage: AgentLogStage | undefined,
  fn: (stage: AgentLogStage) => Promise<T>,
): Promise<T> {
  const stage = await deps.logger.stage(`Output: ${label}`, {
    parent: parentStage,
    skip: true,
  });
  return stage.run(() => fn(stage));
}

// ============================================================================
// State Accessors
// ============================================================================

/** Gets the storage key from state, falling back to a normalized null key. */
export function getStorageKey(state: OutputState): StorageKey {
  return state.storageKey ?? normalizeRunId(null);
}

/** Ensures round data exists and returns it. */
export function ensureRoundData(state: OutputState, round: number): RoundData {
  let data = state.rounds.get(round);
  if (!data) {
    data = RoundDataSchema.parse({});
    state.rounds.set(round, data);
  }
  return data;
}

/** Returns true if a round has outputs. */
export function hasRoundOutputs(state: OutputState, round: number): boolean {
  return (state.rounds.get(round)?.outputs.length ?? 0) > 0;
}

/** Ensures a round exists and returns its outputs. */
export function ensureRound(
  state: OutputState,
  round: number,
): OutputFileInfo[] {
  return ensureRoundData(state, round).outputs;
}

/** Returns the map of output files by round. */
export function getOutputFilesByRound(state: OutputState): {
  [key: number]: OutputFileInfo[];
} {
  return Object.fromEntries(
    [...state.rounds].map(([round, data]) => [round, data.outputs]),
  );
}

// ============================================================================
// State Mutation
// ============================================================================

/** Collects support files from agent config for workspace preparation. */
function collectRunSupportFiles(agentConfig: AgentConfig): FileLocation[] {
  const extras = new Map<string, FileLocation>();
  const allPaths = [
    agentConfig.referenceFile,
    ...agentConfig.referenceFiles,
    agentConfig.auxiliaryFile,
    ...agentConfig.auxiliaryFiles,
    agentConfig.mediaFile,
    ...agentConfig.mediaFiles,
    agentConfig.inputFile,
    ...agentConfig.inputFiles,
  ];

  for (const value of allPaths) {
    if (!value) continue;
    const location = typeof value === 'string' ? pathToLocation(value) : value;
    extras.set(getComparablePath(location), location);
  }

  return [...extras.values()];
}

/** Sets the active run and prepares the workspace. */
export function setActiveRun(
  state: OutputState,
  deps: OutputDependencies,
  storageKey: StorageKey,
): void {
  deps.fileService.updateRunContext(deps.executionId);

  if (storageKey === state.storageKey) return;

  // Clear reference to old preparation - allows GC even if it's still running
  // The old operation will complete but its result is discarded
  state.runPreparation = null;

  state.storageKey = storageKey;
  state.openedOutputs.clear();

  const supportFiles = collectRunSupportFiles(deps.agentConfig);
  state.runPreparation = deps.fileService.prepareRunWorkspace(deps.baseFiles, {
    linkFiles: supportFiles,
  });
}
