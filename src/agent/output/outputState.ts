/**
 * State management for output processing.
 *
 * Manages mutable state for output files across rounds, including
 * round data, storage keys, and workspace preparation.
 */

import { z } from 'zod';

import type { StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { normalizeRunId } from '@common/constants/runIds';
import type { TexraTrace } from '@logger';
import {
  CompileFailureSchema,
  FileLocationSchema,
  OutputFileInfoSchema,
  OutputXmlSummarySchema,
  type CompileFailure,
  type OutputFileInfo,
  type StorageKey,
} from '@shared/schemas';
import {
  TaskRunFileService,
  getComparablePath,
  pathToLocation,
  type FileLocation,
} from '@utils/files';

const RoundDataSchema = z.object({
  outputs: OutputFileInfoSchema.array().prefault(() => []),
  compileFailures: CompileFailureSchema.array().prefault(() => []),
  rawOutput: FileLocationSchema.nullable().prefault(null),
  xmlSummary: OutputXmlSummarySchema.prefault(() => ({})),
});

export type RoundData = z.infer<typeof RoundDataSchema>;

export interface OutputState {
  rounds: Map<number, RoundData>;
  openedOutputs: Set<string>;
  storageKey: StorageKey | null;
  runPreparation: Promise<void> | null;
}

export interface OutputDependencies {
  setting: AgentWorkflowSetting;
  config: AgentConfig;
  baseFiles: FileLocation[];
  logger: TexraTrace;
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

export function ensureRoundData(state: OutputState, round: number): RoundData {
  let data = state.rounds.get(round);
  if (!data) {
    data = RoundDataSchema.parse({});
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

export function ensureRound(
  state: OutputState,
  round: number,
): OutputFileInfo[] {
  return ensureRoundData(state, round).outputs;
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
