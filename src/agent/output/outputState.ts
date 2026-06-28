/**
 * State management for output processing.
 *
 * Manages mutable state for output files across rounds, including
 * round data, storage keys, and workspace preparation.
 *
 * `OutputState.rounds` stores mutable `RoundOutput` objects — the same type
 * persisted in `ReflectionFlowShared.roundOutputs`. Each round's entry is
 * built up in-place during processing; `OutputNode.post()` then writes the
 * completed entry to shared state for persistence.
 */

import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import { normalizeRunId } from '@common/constants/runIds';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  OutputXmlSummarySchema,
  type CompileFailure,
  type FileLocation,
  type OutputFileInfo,
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
  executionId: string;
  streamId: string;
  runtimeHost: AgentRuntimeHost;
}

export function createOutputState(): OutputState {
  return {
    rounds: new Map(),
    openedOutputs: new Set(),
    storageKey: null,
    runPreparation: null,
  };
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
  let data = state.rounds.get(round);
  if (!data) {
    data = {
      round,
      rawOutput: null,
      outputs: [],
      compileFailures: [],
      xmlSummary: OutputXmlSummarySchema.parse({}),
    };
    state.rounds.set(round, data);
  }
  return data;
}

export function hasRoundOutputs(state: OutputState, round: number): boolean {
  return (state.rounds.get(round)?.outputs.length ?? 0) > 0;
}

export function hasCompileFailures(state: OutputState, round: number): boolean {
  return (state.rounds.get(round)?.compileFailures.length ?? 0) > 0;
}

export function getOutputFilesByRound(state: OutputState): {
  [key: number]: OutputFileInfo[];
} {
  return Object.fromEntries(
    [...state.rounds].map(([round, data]) => [round, data.outputs]),
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
    const location = typeof value === 'string' ? pathToLocation(value) : value;
    extras.set(getComparablePath(location), location);
  }

  return [...extras.values()];
}

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

  const supportFiles = collectRunSupportFiles(deps.config);
  state.runPreparation = deps.fileService.prepareRunWorkspace(deps.baseFiles, {
    linkFiles: supportFiles,
  });
}
