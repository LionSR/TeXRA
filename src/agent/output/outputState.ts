/**
 * State management for output processing.
 *
 * Manages mutable state for output files across rounds, including
 * round data, storage keys, and workspace preparation.
 *
 * `OutputState.rounds` is the canonical live collection, keyed by round
 * index (`Map<number, RoundOutput>`). The reflection flow hydrates it from
 * the persisted `roundOutputs` array on startup via `roundsFromPersisted`
 * and projects it back to that array shape via `roundsToPersisted` before
 * each round is persisted.
 */

import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { normalizeRunId } from '@common/constants/runIds';
import {
  OutputXmlSummarySchema,
  type CompileFailure,
  type FileLocation,
  type OutputFileInfo,
  type RoundIndexed,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import {
  TaskRunFileService,
  getComparablePath,
  pathToLocation,
} from '@utils/files';

export interface OutputState {
  rounds: Map<number, RoundOutput>;
  openedOutputs: Set<string>;
  storageKey: StorageKey | null;
  runPreparation: Promise<void> | null;
}

export interface OutputDependencies {
  setting: AgentWorkflowSetting;
  config: AgentConfig;
  baseFiles: FileLocation[];
  logger: AgentTrace;
  fileService: TaskRunFileService;
  streamId: string;
  interactions: SessionHostInteractions;
}

export function createOutputState(
  rounds: Map<number, RoundOutput> = new Map(),
): OutputState {
  return {
    rounds,
    openedOutputs: new Set(),
    storageKey: null,
    runPreparation: null,
  };
}

/**
 * Build a live `rounds` map from the persisted array shape, keyed by each
 * entry's own `round` field (not array index) so a hydration source with
 * gaps still lands on the right round.
 */
export function roundsFromPersisted(
  rounds: RoundOutput[],
): Map<number, RoundOutput> {
  return new Map(rounds.map((round) => [round.round, round]));
}

/**
 * Project the live `rounds` map back to the persisted array shape, placing
 * each entry at its own `round` index (not insertion order) — some
 * consumers of the persisted shape (e.g. `getFilesForRound`) index it
 * positionally by round number, and a round can in principle be absent
 * without shifting the rounds after it.
 */
export function roundsToPersisted(state: OutputState): RoundOutput[] {
  const result: RoundOutput[] = [];
  for (const [round, data] of state.rounds) {
    result[round] = data;
  }
  return result;
}

export async function withOutputStage<T>(
  deps: OutputDependencies,
  label: string,
  parentStage: StageHandle | undefined,
  fn: (stage: StageHandle) => Promise<T>,
): Promise<T> {
  const stage = deps.logger.openStage(`Output: ${label}`, {
    parent: parentStage,
    skip: true,
  });
  return stage.run(() => fn(stage));
}

export function getStorageKey(state: OutputState): StorageKey {
  return state.storageKey ?? normalizeRunId(null);
}

export function ensureRoundData(
  state: OutputState,
  round: number,
): RoundOutput {
  const existing = state.rounds.get(round);
  if (existing) return existing;
  const data: RoundOutput = {
    round,
    rawOutput: null,
    outputs: [],
    compileFailures: [],
    xmlSummary: OutputXmlSummarySchema.parse({}),
  };
  state.rounds.set(round, data);
  return data;
}

export function hasRoundOutputs(state: OutputState, round: number): boolean {
  return (state.rounds.get(round)?.outputs.length ?? 0) > 0;
}

export function hasCompileFailures(state: OutputState, round: number): boolean {
  return (state.rounds.get(round)?.compileFailures.length ?? 0) > 0;
}

export function getOutputFilesByRound(
  state: OutputState,
): RoundIndexed<OutputFileInfo> {
  return Object.fromEntries(
    [...state.rounds].map(([round, data]) => [round, data.outputs] as const),
  );
}

export function setCompileFailures(
  state: OutputState,
  round: number,
  failures: CompileFailure[],
): void {
  ensureRoundData(state, round).compileFailures = failures;
}

function collectRunSupportFiles(agentConfig: AgentConfig): FileLocation[] {
  const allPaths = [
    ...agentConfig.contextFiles,
    ...agentConfig.mediaFiles,
    ...agentConfig.inputFiles,
  ];

  const extras = new Map<string, FileLocation>();
  for (const value of allPaths) {
    if (!value) continue;
    const location = pathToLocation(value);
    extras.set(getComparablePath(location), location);
  }

  return [...extras.values()];
}

export function setActiveRun(
  state: OutputState,
  deps: OutputDependencies,
  storageKey: StorageKey,
): void {
  if (storageKey === state.storageKey) return;

  // Clear reference to old preparation - allows GC even if it's still running
  // The old operation will complete but its result is discarded
  state.runPreparation = null;

  state.storageKey = storageKey;
  state.openedOutputs.clear();

  const supportFiles = collectRunSupportFiles(deps.config);
  state.runPreparation = deps.fileService.prepareRunWorkspace(deps.baseFiles, {
    linkFiles: supportFiles,
  });
}
