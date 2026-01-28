/**
 * Standalone utility functions for output processing.
 *
 * These functions handle output file processing and validation for agent responses.
 * They operate on an OutputState object that contains the mutable state.
 */

import { diff_match_patch } from 'diff-match-patch';
import { z } from 'zod';

import {
  FileLocationSchema,
  MESSAGE_TYPES,
  OutputFileInfoSchema,
  OutputXmlSummarySchema,
  type FileLocation,
  type OutputFileInfo,
  type OutputXmlSummary,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { DiffStats } from '@agent/types/DiffTypes';
import { normalizeRunId } from '@common/constants/runIds';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import type { AgentLogger, AgentLogStage } from '@logger/AgentLogger';
import {
  TaskRunFileService,
  flexibleFS,
  getComparablePath,
  pathToLocation,
} from '@utils/files';
import { countLines } from '@utils/text/stringUtils';

import { FileLineageCalculator } from './FileLineageCalculator';
import { LatexDiffManager } from './LatexDiffManager';
import { OutputFileProcessor, type ProcessingContext } from './OutputFileProcessor';
import { XmlOutputManager } from './XmlOutputManager';
import type { RoundFileMapping } from './types';

// ============================================================================
// Schemas and Types
// ============================================================================

const RoundDataSchema = z.object({
  outputs: OutputFileInfoSchema.array().prefault(() => []),
  rawOutput: FileLocationSchema.nullable().prefault(null),
  xmlSummary: OutputXmlSummarySchema.prefault(() => ({})),
});

type RoundData = z.infer<typeof RoundDataSchema>;

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

/** Result of validateOutputsExist - data for caller to handle events/UI. */
export interface ValidationResult {
  storageKey: StorageKey;
  currRound: number;
  missing: string[];
  xmlExists: boolean;
}

/** Result of finalizeRoundData - data for caller to handle events/file opening. */
export interface FinalizeRoundResult {
  storageKey: StorageKey;
  currRound: number;
  fileInfos: OutputFileInfo[];
  filesToOpen: FileLocation[];
  outputFile: FileLocation;
  endTurn: boolean;
  stage?: AgentLogStage;
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
// Internal Helpers
// ============================================================================

function ensureRoundData(state: OutputState, round: number): RoundData {
  let data = state.rounds.get(round);
  if (!data) {
    data = RoundDataSchema.parse({});
    state.rounds.set(round, data);
  }
  return data;
}

function getStorageKey(state: OutputState): StorageKey {
  return state.storageKey ?? normalizeRunId(null);
}

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

async function computeDiffStats(
  baseLocation: FileLocation | null,
  outputLocation: FileLocation,
): Promise<DiffStats> {
  try {
    if (!baseLocation) {
      const outContent = await flexibleFS.read(outputLocation);
      const added = countLines(outContent);
      return { added };
    }

    const [baseContent, outContent] = await Promise.all([
      flexibleFS.read(baseLocation),
      flexibleFS.read(outputLocation),
    ]);

    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(baseContent, outContent);
    let added = 0;
    let removed = 0;
    for (const [op, text] of diffs) {
      if (op === 1) {
        added += countLines(text);
      } else if (op === -1) {
        removed += countLines(text);
      }
    }
    return { added, removed };
  } catch {
    return {};
  }
}

async function withOutputStage<T>(
  logger: AgentLogger,
  label: string,
  parentStage: AgentLogStage | undefined,
  fn: (stage: AgentLogStage) => Promise<T>,
): Promise<T> {
  const stage = await logger.stage(`Output: ${label}`, {
    parent: parentStage,
    skip: true,
  });
  return stage.run(() => fn(stage));
}

async function prepareRunWorkspaceIfNeeded(
  state: OutputState,
  logger: AgentLogger,
): Promise<void> {
  if (!state.runPreparation) return;

  try {
    await state.runPreparation;
  } catch (error) {
    logger.debug(
      `Failed to prepare run workspace: ${toErrorMessage(error)}`,
      { messageType: MESSAGE_TYPES.INTERNAL },
    );
  } finally {
    state.runPreparation = null;
  }
}

// ============================================================================
// Public Functions
// ============================================================================

/** Sets the active run and prepares the workspace. */
export function setActiveRun(
  state: OutputState,
  deps: OutputDependencies,
  storageKey: StorageKey,
): void {
  deps.fileService.updateRunContext(deps.executionId);

  if (storageKey === state.storageKey) return;

  state.storageKey = storageKey;
  state.openedOutputs.clear();

  const supportFiles = collectRunSupportFiles(deps.agentConfig);
  state.runPreparation = deps.fileService.prepareRunWorkspace(deps.baseFiles, {
    linkFiles: supportFiles,
  });
}

/** Returns the map of output files by round. */
export function getOutputFilesByRound(
  state: OutputState,
): { [key: number]: OutputFileInfo[] } {
  return Object.fromEntries(
    [...state.rounds].map(([round, data]) => [round, data.outputs]),
  );
}

/** Ensures a round exists and returns its outputs. */
export function ensureRound(state: OutputState, round: number): OutputFileInfo[] {
  return ensureRoundData(state, round).outputs;
}

/** Returns true if a round has outputs. */
export function hasRoundOutputs(state: OutputState, round: number): boolean {
  return (state.rounds.get(round)?.outputs.length ?? 0) > 0;
}

/** Creates a LatexDiffManager for handling latexdiff operations. */
export function createDiffManager(
  state: OutputState,
  deps: OutputDependencies,
): LatexDiffManager {
  return new LatexDiffManager(
    deps.agentSetting,
    () => getOutputFilesByRound(state),
    deps.baseFiles,
    deps.logger,
    deps.streamId,
    deps.fileService,
  );
}

/** Creates an XmlOutputManager for XML processing. */
export function createXmlManager(
  deps: OutputDependencies,
): XmlOutputManager {
  return new XmlOutputManager(
    deps.agentSetting,
    deps.agentConfig,
    deps.logger,
    deps.fileService,
  );
}

/** Ensures the XML output file has correct structure (closing tags, etc.). */
export async function ensureXmlStructure(
  xmlManager: XmlOutputManager,
  fileLocation: FileLocation,
  documentTag: string,
): Promise<void> {
  await xmlManager.ensureCorrectXmlStructure(fileLocation, documentTag);
}

/** Gets the file lineage mapping for a round. */
export function calculateRoundMapping(
  state: OutputState,
  baseFiles: FileLocation[],
  currRound: number,
): RoundFileMapping {
  const currentOutputs = state.rounds.get(currRound)?.outputs ?? [];
  const prevOutputs =
    (currRound > 0 ? state.rounds.get(currRound - 1)?.outputs : undefined) ?? [];

  const lineageCalculator = new FileLineageCalculator(baseFiles);
  return lineageCalculator.calculateMapping(currentOutputs, prevOutputs);
}

/** Gathers file info with diff stats for a round. */
export async function gatherRoundFileInfo(
  state: OutputState,
  baseFiles: FileLocation[],
  currRound: number,
  precomputedMapping?: RoundFileMapping,
): Promise<OutputFileInfo[]> {
  const roundOutputs = ensureRound(state, currRound);
  const mapping = precomputedMapping ?? calculateRoundMapping(state, baseFiles, currRound);

  return Promise.all(
    roundOutputs.map(async (output) => {
      const location = output.location;
      const locationPath = getComparablePath(location);

      const baseLocation = mapping.baseToOutput.get(locationPath) ?? null;
      const originalLocation = mapping.originByOutput.get(locationPath) ?? null;
      const originalIsDifferentFile =
        originalLocation && getComparablePath(originalLocation) !== locationPath;
      let diffBaseLocation = baseLocation;
      if (!diffBaseLocation && originalIsDifferentFile) {
        diffBaseLocation = originalLocation;
      }

      const stats = await computeDiffStats(diffBaseLocation, location);

      return {
        source: output.source,
        round: output.round,
        location,
        lineage: {
          original: originalLocation,
          diffBase: diffBaseLocation,
          diffFile: null,
        },
        diff: stats,
      };
    }),
  );
}

/** Validates expected outputs exist. */
export async function validateOutputsExist(
  state: OutputState,
  deps: OutputDependencies,
  outputLocation: FileLocation,
  currRound: number,
  stage?: AgentLogStage,
): Promise<ValidationResult> {
  return withOutputStage(
    deps.logger,
    `Validate expected r${currRound}`,
    stage,
    async (): Promise<ValidationResult> => {
      const storageKey = getStorageKey(state);
      const expected = deps.agentConfig.outputFiles;
      if (!expected || expected.length === 0) {
        deps.logger.debug(
          `No expected outputs for round ${currRound} storageKey=${storageKey}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );
        return { storageKey, currRound, missing: [], xmlExists: false };
      }

      const checks = expected.map(async (file) => ({
        file,
        exists: await flexibleFS.exists(deps.fileService.createLocation(file)),
      }));
      const results = await Promise.all(checks);
      const missing = results.filter((r) => !r.exists).map((r) => r.file);
      const xmlExists = await flexibleFS.exists(outputLocation);

      if (missing.length > 0) {
        deps.logger.missingOutputs({
          missing,
          xmlFile: xmlExists ? outputLocation.absolutePath : null,
          documentTag: deps.agentSetting.documentTag,
        });
        deps.logger.debug(
          `Missing expected outputs for round ${currRound}: ${missing.join(', ')}`,
        );
      } else {
        deps.logger.debug(`All expected outputs exist after round ${currRound}`);
      }

      return { storageKey, currRound, missing, xmlExists };
    },
  );
}

/** Finalizes round data and returns results for event emission/file opening. */
export async function finalizeRoundData(
  state: OutputState,
  deps: OutputDependencies,
  outputFile: FileLocation,
  currRound: number,
  options: {
    endTurn: boolean;
    stage?: AgentLogStage;
    mapping?: RoundFileMapping;
  },
): Promise<FinalizeRoundResult> {
  return withOutputStage(
    deps.logger,
    `Finalize r${currRound}`,
    options.stage,
    async (scope): Promise<FinalizeRoundResult> => {
      const data = ensureRoundData(state, currRound);
      data.rawOutput ??= outputFile;

      const fileInfos = await gatherRoundFileInfo(
        state,
        deps.baseFiles,
        currRound,
        options.mapping,
      );
      data.outputs = fileInfos;
      const storageKey = getStorageKey(state);

      // Collect file paths that haven't been opened yet
      const filesToOpen: FileLocation[] = [];
      for (const info of fileInfos) {
        const filePath = info.location.absolutePath;
        if (!state.openedOutputs.has(filePath)) {
          filesToOpen.push(info.location);
          state.openedOutputs.add(filePath);
        }
      }

      deps.logger.debug(
        `Finalized round ${currRound} storageKey=${storageKey} files=${fileInfos.length}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );

      return {
        storageKey,
        currRound,
        fileInfos,
        filesToOpen,
        outputFile,
        endTurn: options.endTurn,
        stage: scope,
      };
    },
  );
}

/** Processes output files for a round. */
export async function processRoundOutputs(
  state: OutputState,
  deps: OutputDependencies,
  xmlManager: XmlOutputManager,
  outputLocation: FileLocation,
  currRound: number,
  stage?: AgentLogStage,
): Promise<void> {
  await withOutputStage(
    deps.logger,
    `Process files r${currRound}`,
    stage,
    async () => {
      await prepareRunWorkspaceIfNeeded(state, deps.logger);

      const data = ensureRoundData(state, currRound);
      data.rawOutput ??= outputLocation;
      const rawLocation = data.rawOutput;

      const processingContext: ProcessingContext = {
        agentSetting: deps.agentSetting,
        baseFiles: deps.baseFiles,
        streamId: deps.streamId,
        logger: deps.logger,
        xmlManager,
        setRoundOutputs: (round: number, outputs: OutputFileInfo[]) => {
          const roundData = ensureRoundData(state, round);
          roundData.outputs = outputs;
        },
        ensureRoundData: (round: number) => ensureRoundData(state, round),
      };

      const fileProcessor = new OutputFileProcessor(processingContext);

      const hasMultipleOutputs =
        deps.agentConfig.useMultipleOutputs &&
        deps.agentConfig.outputFiles?.length > 0;

      if (hasMultipleOutputs) {
        await fileProcessor.processMultipleOutputs(
          outputLocation,
          currRound,
          rawLocation,
        );
        return;
      }

      await fileProcessor.processSingleOutput(
        outputLocation,
        currRound,
        rawLocation,
        getStorageKey(state),
      );
    },
  );
}

/** Gets round output artifacts. */
export async function getRoundArtifacts(
  state: OutputState,
  baseFiles: FileLocation[],
  round: number,
): Promise<RoundOutput> {
  const data = ensureRoundData(state, round);

  if (data.outputs.length === 0) {
    data.outputs = await gatherRoundFileInfo(state, baseFiles, round);
  }

  return {
    round,
    rawOutput: data.rawOutput,
    outputs: data.outputs,
    xmlSummary: data.xmlSummary,
  };
}
